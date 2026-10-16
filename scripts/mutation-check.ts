// Breaks each key safeguard on purpose, one at a time, and checks that a test fails.
// A mutant that survives means the test is wrong, not the code.  Run: npm run mutate
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Mutant {
  name: string;
  file: string;
  from: string;
  to: string;
  tests: string[];
}

const mutants: Mutant[] = [
  { name: 'refund allowed without a lookup', file: 'src/evals/checks.ts', from: 'if (!id || !looked.has(id))', to: 'if (!id)', tests: ['test/unit/checks.test.ts'] },
  { name: 'second refund allowed', file: 'src/evals/checks.ts', from: 'refunds > 1 ?', to: 'refunds > 2 ?', tests: ['test/unit/checks.test.ts'] },
  { name: 'tool-call budget off by one', file: 'src/evals/checks.ts', from: 'trace.toolCalls.length > MAX_TOOL_CALLS', to: 'trace.toolCalls.length > MAX_TOOL_CALLS + 1', tests: ['test/unit/checks.test.ts'] },
  { name: 'in_order matching treated as any_order', file: 'src/evals/checks.ts', from: "if (mode === 'any_order') return", to: "if (mode !== 'exact') return", tests: ['test/unit/checks.test.ts'] },
  { name: 'missing telemetry scored instead of reported', file: 'src/evals/checks.ts', from: 'if (missing.length > 0) {', to: 'if (missing.length > 99) {', tests: ['test/unit/checks.test.ts', 'test/unit/evaluator.test.ts'] },
  { name: 'code fences stripped before parsing', file: 'src/agent/output.ts', from: 'json = JSON.parse(text);', to: "json = JSON.parse(text.replace(/^```json\\n|\\n```$/g, ''));", tests: ['test/unit/checks.test.ts'] },
  { name: 'empty run passes', file: 'src/evals/gate.ts', from: "if (result.totalTrials === 0) reasons.push('no eval trials ran');", to: '', tests: ['test/unit/gate.test.ts'] },
  { name: 'critical cases judged by average', file: 'src/evals/gate.ts', from: 'if (c.critical && failed > 0)', to: 'if (c.critical && failed === c.trials.length)', tests: ['test/unit/gate.test.ts', 'test/unit/cli.test.ts'] },
  { name: 'deleted case not noticed', file: 'src/evals/gate.ts', from: "if (!now) reasons.push(`case ${id} is in the baseline but did not run`);", to: 'if (!now) continue;', tests: ['test/unit/gate.test.ts', 'test/unit/cli.test.ts'] },
  { name: 'no float slack on the baseline drop', file: 'src/evals/gate.ts', from: 'now.passRate + config.maxCaseDrop + EPS < base', to: 'now.passRate + config.maxCaseDrop < base', tests: ['test/unit/gate.test.ts'] },
  { name: 'errored trials ignored', file: 'src/evals/gate.ts', from: 'if (result.erroredTrials > 0) {', to: 'if (result.erroredTrials > 999) {', tests: ['test/unit/gate.test.ts'] },
  { name: 'tool lets a refund exceed what is left', file: 'src/agent/tools.ts', from: 'if (amount > left)', to: 'if (amount > o.total)', tests: ['test/unit/tools.test.ts'] },
  { name: 'evaluator ignores the target trace', file: 'src/evaluator/handler.ts', from: 'input.evaluationTarget?.traceIds?.length ? input.evaluationTarget.traceIds : [...traces.keys()]', to: '[...traces.keys()]', tests: ['test/unit/evaluator.test.ts'] },
  { name: 'zod left out of the Lambda bundle', file: 'infra/lib/evals-stack.ts', from: 'externalModules: [],', to: "externalModules: ['zod'],", tests: ['test/infra/bundle.test.ts'] },
  { name: 'evaluator timeout shorter than the function', file: 'infra/lib/evals-stack.ts', from: 'lambdaTimeoutInSeconds: EVALUATOR_TIMEOUT.toSeconds()', to: 'lambdaTimeoutInSeconds: 10', tests: ['test/infra/stack.test.ts'] },
  { name: 'execution role trust without SourceArn', file: 'infra/lib/evals-stack.ts', from: "ArnLike: {\n            'aws:SourceArn'", to: "ArnLikeX: {\n            'aws:SourceArn'", tests: ['test/infra/stack.test.ts'] },
];

const root = join(__dirname, '..');
let survived = 0;
for (const m of mutants) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  if (original.split(m.from).length !== 2) throw new Error(`"${m.name}": the text to mutate must appear exactly once in ${m.file}`);
  writeFileSync(path, original.replace(m.from, m.to));
  let killed = false;
  try {
    execFileSync('npx', ['jest', '--silent', ...m.tests], { cwd: root, stdio: 'pipe', timeout: 300_000 });
  } catch {
    killed = true;
  } finally {
    writeFileSync(path, original);
  }
  if (!killed) survived++;
  process.stdout.write(`${killed ? 'killed  ' : 'SURVIVED'}  ${m.name}\n`);
}
process.stdout.write(`\n${mutants.length - survived} of ${mutants.length} mutants killed\n`);
process.exit(survived === 0 ? 0 : 1);
