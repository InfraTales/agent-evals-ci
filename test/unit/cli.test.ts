import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/run-evals';

const REPO_EVALS = join(__dirname, '..', '..', 'evals');
let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evals-'));
  cpSync(REPO_EVALS, join(dir, 'evals'), { recursive: true });
  env = { EVALS_DIR: join(dir, 'evals'), REPORTS_DIR: join(dir, 'reports'), GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => jest.restoreAllMocks());

const readCases = (): { cases: { id: string; stub: unknown[][] }[] } => JSON.parse(readFileSync(join(dir, 'evals', 'cases.json'), 'utf8'));

test('the repo suite passes in stub mode and writes the report and the job summary', async () => {
  expect(await main([], env)).toBe(0);
  const report = JSON.parse(readFileSync(join(dir, 'reports', 'eval-stub.json'), 'utf8'));
  expect(report.verdict.ok).toBe(true);
  expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toMatch(/## Agent evals: PASS/);
});

test('a regression in a critical case exits 1', async () => {
  const file = readCases();
  // Make the "refund-delivered" script skip the lookup, as a model might.
  const c = file.cases.find((x) => x.id === 'refund-delivered')!;
  c.stub = [c.stub[0]!.slice(1)];
  writeFileSync(join(dir, 'evals', 'cases.json'), JSON.stringify(file));
  expect(await main([], env)).toBe(1);
  expect(readFileSync(join(dir, 'reports', 'eval-stub.md'), 'utf8')).toMatch(/critical case refund-delivered failed 3 of 3/);
});

test('deleting a case to go green exits 1, because the baseline still lists it', async () => {
  const file = readCases();
  file.cases = file.cases.filter((x) => x.id !== 'refund-partial');
  writeFileSync(join(dir, 'evals', 'cases.json'), JSON.stringify(file));
  expect(await main([], env)).toBe(1);
});

test('--update-baseline writes the current pass rates', async () => {
  const path = join(dir, 'evals', 'baseline.stub.json');
  writeFileSync(path, JSON.stringify({ mode: 'stub', model: 'old', passRate: 0, cases: {} }));
  expect(await main(['--update-baseline'], env)).toBe(0);
  expect(JSON.parse(readFileSync(path, 'utf8')).cases['refund-partial']).toBeCloseTo(2 / 3);
});

test('live mode refuses to start without a model ID', async () => {
  await expect(main([], { ...env, EVAL_MODE: 'live' })).rejects.toThrow('Set the EVAL_MODEL_ID environment variable');
  await expect(main([], { ...env, EVAL_MODE: 'recorded' })).rejects.toThrow('EVAL_MODE must be stub or live');
});

test('a broken cases file stops the run with the file name and the problem', async () => {
  writeFileSync(join(dir, 'evals', 'cases.json'), JSON.stringify({ cases: [{ id: 'Bad ID', input: '', stub: [] }] }));
  await expect(main([], env)).rejects.toThrow(/cases\.json is invalid/);
  expect(existsSync(join(dir, 'reports'))).toBe(false);
});
