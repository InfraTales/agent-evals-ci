import { expectationChecks, MAX_TOOL_CALLS, NotEvaluable, policyChecks, trajectoryMatches } from '../../src/evals/checks';
import { lookup, refund, trace } from '../support/traces';

const failing = (rs: { check: string; pass: boolean }[]): string[] => rs.filter((r) => !r.pass).map((r) => r.check);

test('a clean lookup-then-refund trace passes every policy check', () => {
  expect(failing(policyChecks(trace([lookup(), refund()])))).toEqual([]);
});

test('refunding without a lookup of the same order fails', () => {
  expect(failing(policyChecks(trace([refund()])))).toEqual(['lookup-before-refund']);
  expect(failing(policyChecks(trace([lookup('A-1004'), refund('A-1001')])))).toEqual(['lookup-before-refund']);
  // Looking it up after the refund doesn't count.
  expect(failing(policyChecks(trace([refund(), lookup()])))).toEqual(['lookup-before-refund']);
});

test('two refunds in one conversation fail', () => {
  expect(failing(policyChecks(trace([lookup(), refund('A-1001', 20), refund('A-1001', 22.5)])))).toEqual(['single-refund']);
});

test('tool arguments are checked against the same schemas the tools use', () => {
  const r = policyChecks(trace([lookup(), ['issue_refund', { orderId: 'A-1001', amount: '42.50', reason: 'x' }], ['delete_order', {}]]));
  const bad = r.find((x) => x.check === 'tool-args-valid')!;
  expect(bad.pass).toBe(false);
  expect(bad.detail).toMatch(/amount/);
  expect(bad.detail).toMatch(/unknown tool delete_order/);
});

test('more tool calls than the budget fails, so loops show up', () => {
  const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, () => lookup());
  expect(failing(policyChecks(trace(calls)))).toEqual(['tool-call-budget']);
  expect(failing(policyChecks(trace(calls.slice(1))))).toEqual([]);
});

test('the final answer must be the JSON object and nothing else', () => {
  const fenced = '```json\n{"action":"answered","reply":"hi"}\n```';
  expect(failing(policyChecks(trace([], fenced)))).toEqual(['output-schema']);
  expect(failing(policyChecks(trace([], '{"action":"maybe","reply":"hi"}')))).toEqual(['output-schema']);
  expect(failing(policyChecks(trace([], '{"action":"answered","reply":"hi","extra":1}')))).toEqual(['output-schema']);
  expect(failing(policyChecks(trace([], '{"action":"answered","reply":"hi"}')))).toEqual([]);
});

test('missing telemetry is "not evaluable", never a failure', () => {
  expect(() => policyChecks({ traceId: 't', toolCalls: [{ spanId: 's', name: 'lookup_order' }], response: '{}' })).toThrow(NotEvaluable);
  expect(() => policyChecks(trace([lookup()], null))).toThrow(NotEvaluable);
});

test.each([
  ['exact', ['a', 'b'], ['a', 'b'], true],
  ['exact', ['a', 'b', 'c'], ['a', 'b'], false],
  ['exact', ['b', 'a'], ['a', 'b'], false],
  ['exact', [], [], true],
  ['in_order', ['a', 'x', 'b'], ['a', 'b'], true],
  ['in_order', ['b', 'a'], ['a', 'b'], false],
  ['in_order', ['a'], ['a', 'b'], false],
  ['any_order', ['b', 'x', 'a'], ['a', 'b'], true],
  ['any_order', ['a'], ['a', 'b'], false],
] as const)('trajectory %s: %j vs expected %j -> %s', (mode, actual, expected, want) => {
  expect(trajectoryMatches(actual, expected, mode)).toBe(want);
});

test('expectations check trajectory, forbidden tools, arguments and output fields', () => {
  const t = trace([lookup(), refund('A-1001', 40)]);
  const r = expectationChecks(t, {
    trajectory: { mode: 'exact', tools: ['lookup_order', 'issue_refund'] },
    forbiddenTools: ['escalate_to_human', 'issue_refund'],
    toolArgs: [{ tool: 'issue_refund', match: { orderId: 'A-1001', amount: 42.5 } }],
    output: { action: 'refunded' },
  });
  expect(failing(r)).toEqual(['forbidden:issue_refund', 'args:issue_refund']);
  expect(failing(expectationChecks(trace([]), {}))).toEqual([]);
  expect(failing(expectationChecks(trace([], 'not json'), { output: { action: 'answered' } }))).toEqual(['output-match']);
});
