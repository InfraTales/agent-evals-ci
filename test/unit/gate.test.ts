import { gate, toBaseline } from '../../src/evals/gate';
import type { CaseResult, SuiteResult, TrialResult } from '../../src/evals/runner';

const config = { trials: 3, minPassRate: 0.9, maxCaseDrop: 0 };

function trials(pattern: string): TrialResult[] {
  return [...pattern].map((p, trial) =>
    p === 'E' ? { trial, pass: false, checks: [], error: 'ThrottlingException' } : { trial, pass: p === '1', checks: [] },
  );
}

function suite(cases: [string, string, boolean?][]): SuiteResult {
  const cs: CaseResult[] = cases.map(([id, p, critical]) => {
    const t = trials(p);
    return { id, critical: critical ?? false, trials: t, passRate: t.length ? t.filter((x) => x.pass).length / t.length : 0 };
  });
  const all = cs.flatMap((c) => c.trials);
  const passed = all.filter((t) => t.pass).length;
  return {
    mode: 'stub', model: 'scripted', trialsPerCase: 3, cases: cs,
    passedTrials: passed, totalTrials: all.length, passRate: all.length ? passed / all.length : 0,
    erroredTrials: all.filter((t) => t.error).length,
    tokens: { input: 0, output: 0 },
  };
}

test('a clean run passes', () => {
  expect(gate(suite([['a', '111', true], ['b', '111']]), config)).toEqual({ ok: true, reasons: [] });
});

test('an empty run fails instead of passing with 0 of 0', () => {
  expect(gate(suite([]), config).reasons).toEqual(['no eval trials ran']);
});

test('one miss on a critical case fails the build even when the overall rate is high', () => {
  const s = suite([['crit', '110', true], ...Array.from({ length: 20 }, (_, i): [string, string] => [`c${i}`, '111'])]);
  expect(s.passRate).toBeGreaterThan(0.98);
  expect(gate(s, config).reasons).toEqual(['critical case crit failed 1 of 3 trials']);
});

test('the overall pass rate must reach the minimum', () => {
  const r = gate(suite([['a', '110'], ['b', '110'], ['c', '111']]), config);
  expect(r.reasons).toEqual(['pass rate 77.8% is below the 90.0% minimum']);
});

test('a drop of exactly maxCaseDrop is allowed, even where floating point says otherwise', () => {
  // 0.7 + 0.2 is 0.8999999999999999 in JavaScript, which is less than 0.9.
  const base = toBaseline(suite([['a', '1111111110']]));
  const now = suite([['a', '1111111000']]);
  expect(now.cases[0]!.passRate + 0.2 < 0.9).toBe(true);
  expect(gate(now, { ...config, minPassRate: 0, maxCaseDrop: 0.2 }, base).ok).toBe(true);
});

test('errored trials fail the gate with their own reason', () => {
  const r = gate(suite([['a', '11E']]), { ...config, minPassRate: 0 });
  expect(r.reasons).toEqual(['1 trial(s) errored before they could be checked; fix or rerun']);
});

test('a case that falls below its baseline fails; a case removed from the suite fails too', () => {
  const base = toBaseline(suite([['a', '111'], ['b', '110'], ['gone', '111']]));
  const r = gate(suite([['a', '110'], ['b', '110']]), { ...config, minPassRate: 0 }, base);
  expect(r.reasons).toEqual(['case a regressed from 100.0% to 66.7%', 'case gone is in the baseline but did not run']);
});

test('maxCaseDrop allows exactly one flaky trial out of three when set to a third', () => {
  const base = toBaseline(suite([['a', '111']]));
  expect(gate(suite([['a', '110']]), { ...config, minPassRate: 0, maxCaseDrop: 1 / 3 }, base).ok).toBe(true);
  expect(gate(suite([['a', '100']]), { ...config, minPassRate: 0, maxCaseDrop: 1 / 3 }, base).ok).toBe(false);
});
