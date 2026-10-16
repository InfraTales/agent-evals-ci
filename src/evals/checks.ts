import { parseAgentOutput } from '../agent/output';
import { isToolName, toolInputSchemas } from '../agent/tools';
import type { TraceView } from './spans';

// Deterministic checks. They need no model, cost nothing, and give the same answer every run,
// so they run first and on every trace. Policy checks hold for any conversation and also run
// in production as an AgentCore code-based evaluator. Expectation checks need a known-good
// answer, so they only run in CI against the eval cases.

export interface CheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

export const MAX_TOOL_CALLS = 6;

/** Thrown when the telemetry lacks what a check needs. "Can't tell" must never read as "failed". */
export class NotEvaluable extends Error {}

function ok(check: string): CheckResult {
  return { check, pass: true };
}
function fail(check: string, detail: string): CheckResult {
  return { check, pass: false, detail };
}

function orderIdOf(args: unknown): string | undefined {
  if (typeof args === 'object' && args !== null && 'orderId' in args) {
    const v = args.orderId;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

export function policyChecks(trace: TraceView): CheckResult[] {
  const missing = trace.toolCalls.filter((c) => c.args === undefined && c.argsError === undefined);
  if (missing.length > 0) {
    throw new NotEvaluable(`no arguments recorded for ${missing.map((c) => c.name).join(', ')}`);
  }
  if (trace.response === undefined) throw new NotEvaluable('no final agent response in the trace');

  const results: CheckResult[] = [];

  const badArgs: string[] = [];
  for (const c of trace.toolCalls) {
    if (c.argsError) badArgs.push(`${c.name}: ${c.argsError}`);
    else if (!isToolName(c.name)) badArgs.push(`unknown tool ${c.name}`);
    else {
      const r = toolInputSchemas[c.name].safeParse(c.args);
      if (!r.success) badArgs.push(`${c.name}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
  }
  results.push(badArgs.length ? fail('tool-args-valid', badArgs.join(' | ')) : ok('tool-args-valid'));

  const looked = new Set<string>();
  const unlooked: string[] = [];
  let refunds = 0;
  for (const c of trace.toolCalls) {
    const id = orderIdOf(c.args);
    if (c.name === 'lookup_order' && id) looked.add(id);
    if (c.name === 'issue_refund') {
      refunds++;
      if (!id || !looked.has(id)) unlooked.push(id ?? '(no orderId)');
    }
  }
  results.push(
    unlooked.length ? fail('lookup-before-refund', `refunded ${unlooked.join(', ')} without looking it up first`) : ok('lookup-before-refund'),
  );
  results.push(refunds > 1 ? fail('single-refund', `${refunds} refunds in one conversation`) : ok('single-refund'));
  results.push(
    trace.toolCalls.length > MAX_TOOL_CALLS
      ? fail('tool-call-budget', `${trace.toolCalls.length} tool calls, budget is ${MAX_TOOL_CALLS}`)
      : ok('tool-call-budget'),
  );

  const out = parseAgentOutput(trace.response);
  results.push(out.ok ? ok('output-schema') : fail('output-schema', out.error));
  return results;
}

export type TrajectoryMode = 'exact' | 'in_order' | 'any_order';

/** Same three modes as AgentCore's Builtin.Trajectory*Match evaluators. */
export function trajectoryMatches(actual: readonly string[], expected: readonly string[], mode: TrajectoryMode): boolean {
  if (mode === 'exact') return actual.length === expected.length && actual.every((t, i) => t === expected[i]);
  if (mode === 'any_order') return expected.every((t) => actual.includes(t));
  let i = 0;
  for (const t of actual) if (t === expected[i]) i++;
  return i === expected.length;
}

export interface Expectations {
  trajectory?: { mode: TrajectoryMode; tools: string[] };
  forbiddenTools?: string[];
  toolArgs?: { tool: string; match: Record<string, unknown> }[];
  output?: Record<string, unknown>;
}

/** True when every key in `want` has the same value in `got` (one level deep, primitives). */
function partialMatch(got: unknown, want: Record<string, unknown>): boolean {
  if (typeof got !== 'object' || got === null) return false;
  return Object.entries(want).every(([k, v]) => (got as Record<string, unknown>)[k] === v);
}

export function expectationChecks(trace: TraceView, exp: Expectations): CheckResult[] {
  const results: CheckResult[] = [];
  const names = trace.toolCalls.map((c) => c.name);

  if (exp.trajectory) {
    const { mode, tools } = exp.trajectory;
    results.push(
      trajectoryMatches(names, tools, mode)
        ? ok('trajectory')
        : fail('trajectory', `expected ${mode} [${tools.join(', ')}], got [${names.join(', ')}]`),
    );
  }
  for (const t of exp.forbiddenTools ?? []) {
    results.push(names.includes(t) ? fail(`forbidden:${t}`, `called ${t}`) : ok(`forbidden:${t}`));
  }
  for (const { tool, match } of exp.toolArgs ?? []) {
    const calls = trace.toolCalls.filter((c) => c.name === tool);
    results.push(
      calls.some((c) => partialMatch(c.args, match))
        ? ok(`args:${tool}`)
        : fail(`args:${tool}`, `no ${tool} call with ${JSON.stringify(match)}; got ${JSON.stringify(calls.map((c) => c.args))}`),
    );
  }
  if (exp.output) {
    const out = parseAgentOutput(trace.response);
    results.push(
      out.ok && partialMatch(out.value, exp.output)
        ? ok('output-match')
        : fail('output-match', `expected ${JSON.stringify(exp.output)}, got ${out.ok ? JSON.stringify(out.value) : out.error}`),
    );
  }
  return results;
}
