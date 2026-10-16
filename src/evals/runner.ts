import { runAgent, type ModelClient } from '../agent/agent';
import type { EvalCase } from './cases';
import { expectationChecks, NotEvaluable, policyChecks, type CheckResult } from './checks';
import { readTraces } from './spans';

export interface TrialResult {
  trial: number;
  pass: boolean;
  checks: CheckResult[];
  usage?: { inputTokens: number; outputTokens: number };
  /** Infrastructure or harness trouble (throttling, a crash). Not the agent's fault, but not a pass. */
  error?: string;
}

export interface CaseResult {
  id: string;
  critical: boolean;
  trials: TrialResult[];
  passRate: number;
}

export interface SuiteResult {
  mode: string;
  model: string;
  trialsPerCase: number;
  cases: CaseResult[];
  passedTrials: number;
  totalTrials: number;
  passRate: number;
  erroredTrials: number;
  /** Model tokens for the whole run. Multiply by your model's price to see what a run costs. */
  tokens: { input: number; output: number };
}

export type ModelFactory = (c: EvalCase, trial: number) => ModelClient;

export async function runTrial(c: EvalCase, trial: number, model: ModelClient): Promise<TrialResult> {
  try {
    const run = await runAgent({ model, input: c.input, traceId: `${c.id}-t${trial}` });
    const trace = readTraces(run.spans).get(run.traceId);
    if (!trace) throw new Error('the agent produced no spans');
    const checks: CheckResult[] = run.error
      ? [{ check: 'agent-finished', pass: false, detail: run.error }]
      : [...policyChecks(trace), ...expectationChecks(trace, c.expect)];
    return { trial, pass: checks.every((r) => r.pass), checks, usage: run.usage };
  } catch (err) {
    const why = err instanceof NotEvaluable ? `harness bug: ${err.message}` : (err as Error).message;
    return { trial, pass: false, checks: [], error: why };
  }
}

export async function runSuite(opts: {
  cases: readonly EvalCase[];
  trials: number;
  mode: string;
  modelId: string;
  model: ModelFactory;
  concurrency?: number;
}): Promise<SuiteResult> {
  const jobs = opts.cases.flatMap((c) => Array.from({ length: opts.trials }, (_, t) => ({ c, t })));
  const byCase = new Map<string, TrialResult[]>(opts.cases.map((c) => [c.id, []]));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const { c, t } = jobs[next++]!;
      byCase.get(c.id)!.push(await runTrial(c, t, opts.model(c, t)));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker));

  const cases: CaseResult[] = opts.cases.map((c) => {
    const trials = byCase.get(c.id)!.sort((a, b) => a.trial - b.trial);
    const passed = trials.filter((t) => t.pass).length;
    return { id: c.id, critical: c.critical, trials, passRate: trials.length ? passed / trials.length : 0 };
  });
  const all = cases.flatMap((c) => c.trials);
  const passedTrials = all.filter((t) => t.pass).length;
  return {
    mode: opts.mode,
    model: opts.modelId,
    trialsPerCase: opts.trials,
    cases,
    passedTrials,
    totalTrials: all.length,
    passRate: all.length ? passedTrials / all.length : 0,
    erroredTrials: all.filter((t) => t.error !== undefined).length,
    tokens: {
      input: all.reduce((n, t) => n + (t.usage?.inputTokens ?? 0), 0),
      output: all.reduce((n, t) => n + (t.usage?.outputTokens ?? 0), 0),
    },
  };
}
