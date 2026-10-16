import { evaluate, handler } from '../../src/evaluator/handler';
import { runAgent } from '../../src/agent/agent';
import { ScriptedModel, type ScriptTurn } from '../../src/models/scripted';
import split from '../fixtures/strands-split.json';
import unified from '../fixtures/strands-unified.json';

const event = (sessionSpans: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: '1.0',
  evaluatorId: 'order_policy_checks-abc1234567',
  evaluatorName: 'order_policy_checks',
  evaluationLevel: 'TRACE',
  evaluationInput: { sessionSpans },
  evaluationReferenceInputs: [],
  evaluationTarget: { traceIds: [], spanIds: [] },
  ...extra,
});

async function spansFor(script: ScriptTurn[], traceId = 'trace-1') {
  return (await runAgent({ model: new ScriptedModel(script), input: 'x', traceId })).spans;
}

const lookup = { tools: [{ name: 'lookup_order', input: { orderId: 'A-1001' } }] };
const refund = { tools: [{ name: 'issue_refund', input: { orderId: 'A-1001', amount: 42.5, reason: 'broken' } }] };
const done = { finalJson: { action: 'refunded', orderId: 'A-1001', refundAmount: 42.5, reply: 'Done.' } };

test('a good trace gets PASS with value 1', async () => {
  expect(evaluate(event(await spansFor([lookup, refund, done])))).toEqual({ label: 'PASS', value: 1, explanation: 'All 5 policy checks passed.' });
});

test('a refund without a lookup gets FAIL and says why', async () => {
  const r = evaluate(event(await spansFor([refund, done])));
  expect(r).toMatchObject({ label: 'FAIL', value: 0.8 });
  expect('explanation' in r && r.explanation).toMatch(/lookup-before-refund: refunded A-1001 without looking it up first/);
});

test('Strands telemetry in both delivery modes is evaluated', () => {
  expect(evaluate(event(unified))).toMatchObject({ label: 'PASS' });
  expect(evaluate(event(split))).toMatchObject({ label: 'PASS' });
});

test('spans without their content give NOT_EVALUABLE instead of a failing score', () => {
  const spansOnly = split.filter((s) => !('body' in s));
  expect(evaluate(event(spansOnly))).toMatchObject({ errorCode: 'NOT_EVALUABLE' });
});

test('only the target trace is checked when AgentCore names one', async () => {
  const bad = await spansFor([refund, done], 'bad');
  const good = await spansFor([lookup, refund, done], 'good');
  expect(evaluate(event([...bad, ...good], { evaluationTarget: { traceIds: ['good'] } }))).toMatchObject({ label: 'PASS' });
  expect(evaluate(event([...bad, ...good], { evaluationLevel: 'SESSION', evaluationTarget: null }))).toMatchObject({ label: 'FAIL' });
  expect(evaluate(event(good, { evaluationTarget: { traceIds: ['nope'] } }))).toMatchObject({ errorCode: 'TRACE_NOT_FOUND' });
});

test('bad input, tool-level requests and empty sessions get error responses', () => {
  expect(evaluate({ schemaVersion: '2.0' })).toMatchObject({ errorCode: 'INVALID_INPUT' });
  expect(evaluate(event([], { evaluationLevel: 'TOOL_CALL' }))).toMatchObject({ errorCode: 'UNSUPPORTED_LEVEL' });
  expect(evaluate(event([]))).toMatchObject({ errorCode: 'NO_TRACES' });
});

test('the handler logs the label but never the conversation', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await handler(event(await spansFor([lookup, refund, done])));
  expect(log).toHaveBeenCalledWith('{"level":"PASS","value":1}');
  log.mockRestore();
});
