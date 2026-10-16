import type { Baseline, GateConfig } from './cases';
import type { SuiteResult } from './runner';

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

// Rates like 2/3 are not exact in floating point. Compare with a little slack.
const EPS = 1e-9;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Decides whether CI passes. Every rule here exists because a run can look green and be wrong. */
export function gate(result: SuiteResult, config: GateConfig, baseline?: Baseline): GateResult {
  const reasons: string[] = [];

  // An empty run has a pass rate of 0/0. Treat "nothing ran" as a failure, never as a pass.
  if (result.totalTrials === 0) reasons.push('no eval trials ran');

  if (result.erroredTrials > 0) {
    reasons.push(`${result.erroredTrials} trial(s) errored before they could be checked; fix or rerun`);
  }

  for (const c of result.cases) {
    const failed = c.trials.filter((t) => !t.pass).length;
    if (c.critical && failed > 0) reasons.push(`critical case ${c.id} failed ${failed} of ${c.trials.length} trials`);
  }

  if (result.totalTrials > 0 && result.passRate + EPS < config.minPassRate) {
    reasons.push(`pass rate ${pct(result.passRate)} is below the ${pct(config.minPassRate)} minimum`);
  }

  if (baseline) {
    const ran = new Map(result.cases.map((c) => [c.id, c]));
    for (const [id, base] of Object.entries(baseline.cases)) {
      const now = ran.get(id);
      // Deleting a failing case is the easiest way to go green. The baseline makes it visible.
      if (!now) reasons.push(`case ${id} is in the baseline but did not run`);
      else if (now.passRate + config.maxCaseDrop + EPS < base) {
        reasons.push(`case ${id} regressed from ${pct(base)} to ${pct(now.passRate)}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function toBaseline(result: SuiteResult): Baseline {
  return {
    mode: result.mode,
    model: result.model,
    passRate: result.passRate,
    cases: Object.fromEntries(result.cases.map((c) => [c.id, c.passRate])),
  };
}
