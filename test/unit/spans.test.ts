import { readTraces, SpanRecorder } from '../../src/evals/spans';
import split from '../fixtures/strands-split.json';
import unified from '../fixtures/strands-unified.json';

test('reads tool calls and the response from the generic OpenTelemetry attributes the harness writes', () => {
  const rec = new SpanRecorder('t1');
  rec.chat('m');
  rec.tool('lookup_order', 'c1', { orderId: 'A-1001' }, { ok: true }, 'success');
  rec.finish('order_support', 'hi', '{"x":1}');
  const t = readTraces(rec.spans).get('t1')!;
  expect(t.toolCalls).toEqual([{ spanId: 't1-2', name: 'lookup_order', args: { orderId: 'A-1001' } }]);
  expect(t.response).toBe('{"x":1}');
});

test('reads Strands unified telemetry (content in inline span events) and orders calls by start time', () => {
  const t = readTraces(unified).get('69e9cc4771d7cabe0d8e8cea33b6b338')!;
  expect(t.toolCalls.map((c) => c.name)).toEqual(['lookup_order', 'issue_refund']);
  expect(t.toolCalls[1]!.args).toEqual({ orderId: 'A-1001', amount: 42.5, reason: 'arrived broken' });
  expect(JSON.parse(t.response!)).toMatchObject({ action: 'refunded' });
});

test('reads Strands split telemetry (content in separate event records)', () => {
  const t = readTraces(split).get('69e9cc4d132b180909ba49f613f273dd')!;
  expect(t.toolCalls).toEqual([{ spanId: 'fff785ce12d6fda8', name: 'lookup_order', args: { orderId: 'A-1002' } }]);
  expect(JSON.parse(t.response!)).toMatchObject({ action: 'declined' });
});

test('a split-telemetry span without its event record has no arguments, which is different from empty ones', () => {
  const spansOnly = split.filter((s) => !('body' in s));
  const t = readTraces(spansOnly).get('69e9cc4d132b180909ba49f613f273dd')!;
  expect(t.toolCalls[0]!.args).toBeUndefined();
  expect(t.response).toBeUndefined();
});

test('arguments that are not JSON are kept as an error, and junk records are skipped', () => {
  const t = readTraces([
    null,
    { nope: true },
    { traceId: 'x', spanId: 'a', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup_order', 'gen_ai.tool.call.arguments': '{orderId:' } },
    { traceId: 'x', spanId: 'b', attributes: { 'agentcore.invocation.agent_response': 'fallback' } },
  ]).get('x')!;
  expect(t.toolCalls[0]!.argsError).toMatch(/not JSON/);
  expect(t.response).toBe('fallback');
});

test('spans from different traces stay apart', () => {
  const traces = readTraces([...unified, ...split]);
  expect([...traces.keys()].sort()).toEqual(['69e9cc4771d7cabe0d8e8cea33b6b338', '69e9cc4d132b180909ba49f613f273dd']);
});
