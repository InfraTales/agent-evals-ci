import type { GateResult } from './gate';
import type { SuiteResult } from './runner';

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;
// Model output can hold newlines and pipes. Keep each finding on one line of the table or list.
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|');

/** A Markdown summary for the GitHub Actions job page and for humans. */
export function markdownReport(result: SuiteResult, verdict: GateResult): string {
  const lines = [
    `## Agent evals: ${verdict.ok ? 'PASS' : 'FAIL'}`,
    '',
    `Mode \`${result.mode}\`, model \`${result.model}\`, ${result.trialsPerCase} trial(s) per case.`,
    `Passed ${result.passedTrials} of ${result.totalTrials} trials (${pct(result.passRate)}).`,
    `Model tokens: ${result.tokens.input} input, ${result.tokens.output} output.`,
    '',
    '| Case | Critical | Pass rate | First failure |',
    '|---|---|---|---|',
  ];
  for (const c of result.cases) {
    const firstBad = c.trials.find((t) => !t.pass);
    const why = firstBad?.error ?? firstBad?.checks.find((k) => !k.pass)?.check ?? '';
    lines.push(`| ${c.id} | ${c.critical ? 'yes' : ''} | ${pct(c.passRate)} | ${oneLine(why)} |`);
  }
  if (!verdict.ok) {
    lines.push('', '### Why the gate failed', '', ...verdict.reasons.map((r) => `- ${r}`));
  }
  const details = result.cases.flatMap((c) =>
    c.trials
      .filter((t) => !t.pass)
      .map((t) => `- ${c.id} trial ${t.trial}: ${oneLine(t.error ?? t.checks.filter((k) => !k.pass).map((k) => `${k.check} (${k.detail ?? ''})`).join('; '))}`),
  );
  if (details.length) lines.push('', '### Failed trials', '', ...details);
  return lines.join('\n') + '\n';
}
