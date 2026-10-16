import type { EvalCase } from '../../src/evals/cases';
import { runSuite, runTrial } from '../../src/evals/runner';
import { ScriptedModel } from '../../src/models/scripted';

const okFinal = { finalJson: { action: 'answered', reply: 'hi' } };
const base: EvalCase = { id: 'c', input: 'hi', critical: false, expect: { trajectory: { mode: 'exact', tools: [] } }, stub: [[okFinal]] };

test('trial n replays stub variant n modulo the variant count', async () => {
  const c: EvalCase = { ...base, stub: [[okFinal], [{ final: 'not json' }]] };
  const r = await runSuite({ cases: [c], trials: 4, mode: 'stub', modelId: 'scripted', model: (k, t) => new ScriptedModel(k.stub[t % k.stub.length]!) });
  expect(r.cases[0]!.trials.map((t) => t.pass)).toEqual([true, false, true, false]);
  expect(r.passRate).toBe(0.5);
});

test('policy and expectation failures are both reported per trial', async () => {
  const c: EvalCase = { ...base, stub: [[{ tools: [{ name: 'lookup_order', input: { orderId: 'A-1001' } }] }, okFinal]] };
  const t = await runTrial(c, 0, new ScriptedModel(c.stub[0]!));
  expect(t.checks.filter((k) => !k.pass).map((k) => k.check)).toEqual(['trajectory']);
});

test('a model that throws gives an errored trial, not a crash', async () => {
  const t = await runTrial(base, 0, { modelId: 'x', converse: () => Promise.reject(new Error('ThrottlingException')) });
  expect(t).toMatchObject({ pass: false, error: 'ThrottlingException' });
});

test('a run that never finishes is a failed check, not an error', async () => {
  const loop = Array.from({ length: 9 }, () => ({ tools: [{ name: 'lookup_order', input: { orderId: 'A-1001' } }] }));
  const t = await runTrial(base, 0, new ScriptedModel(loop));
  expect(t.error).toBeUndefined();
  expect(t.checks).toEqual([{ check: 'agent-finished', pass: false, detail: 'no final answer after 8 turns' }]);
});

test('concurrent workers still give every trial exactly once, in order', async () => {
  const cases = ['a', 'b', 'c'].map((id) => ({ ...base, id }));
  const r = await runSuite({ cases, trials: 5, mode: 'stub', modelId: 's', model: (k) => new ScriptedModel(k.stub[0]!), concurrency: 4 });
  expect(r.totalTrials).toBe(15);
  for (const c of r.cases) expect(c.trials.map((t) => t.trial)).toEqual([0, 1, 2, 3, 4]);
});
