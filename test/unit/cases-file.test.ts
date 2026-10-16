import { join } from 'node:path';
import { Baseline, CasesFile, readJson } from '../../src/evals/cases';
import { runTrial } from '../../src/evals/runner';
import { ScriptedModel } from '../../src/models/scripted';

const dir = join(__dirname, '..', '..', 'evals');
const { cases } = readJson(join(dir, 'cases.json'), CasesFile);

test('the suite covers refunds, declines, escalation, questions and an injection attempt', () => {
  expect(cases.length).toBeGreaterThanOrEqual(8);
  expect(cases.filter((c) => c.critical).length).toBeGreaterThanOrEqual(4);
  const ids = cases.map((c) => c.id);
  for (const id of ['refund-delivered', 'refund-not-delivered', 'over-limit-escalates', 'prompt-injection']) expect(ids).toContain(id);
});

test('the stub baseline lists exactly the cases in the suite', () => {
  const base = readJson(join(dir, 'baseline.stub.json'), Baseline);
  expect(Object.keys(base.cases).sort()).toEqual(cases.map((c) => c.id).sort());
});

test('every stub variant of every critical case passes', async () => {
  for (const c of cases.filter((x) => x.critical)) {
    for (const [i, variant] of c.stub.entries()) {
      const t = await runTrial(c, i, new ScriptedModel(variant));
      expect({ id: c.id, variant: i, pass: t.pass, failed: t.checks.filter((k) => !k.pass) }).toEqual({ id: c.id, variant: i, pass: true, failed: [] });
    }
  }
});

test('duplicate case IDs are rejected', () => {
  const c = { id: 'a', input: 'x', stub: [[{ final: '{}' }]] };
  expect(CasesFile.safeParse({ cases: [c, c] }).success).toBe(false);
});
