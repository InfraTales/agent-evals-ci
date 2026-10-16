import { runAgent, toolConfig, type ModelClient, type ModelRequest } from '../../src/agent/agent';
import { readTraces } from '../../src/evals/spans';
import { ScriptedModel } from '../../src/models/scripted';

const final = { finalJson: { action: 'answered', reply: 'ok' } };

test('a tool error goes back to the model as a toolResult with status error, and the run continues', async () => {
  const seen: ModelRequest[] = [];
  const inner = new ScriptedModel([
    { tools: [{ name: 'issue_refund', input: { orderId: 'A-1002', amount: 10, reason: 'changed mind' } }] },
    final,
  ]);
  const model: ModelClient = {
    modelId: 'spy',
    converse: (req) => {
      seen.push(structuredClone(req));
      return inner.converse(req);
    },
  };
  const run = await runAgent({ model, input: 'refund A-1002', traceId: 't' });
  expect(run.error).toBeUndefined();
  expect(run.turns).toBe(2);
  const toolResult = seen[1]!.messages[2]!.content![0]!.toolResult!;
  expect(toolResult.status).toBe('error');
  expect(JSON.stringify(toolResult.content)).toMatch(/shipped, not delivered/);
});

test('bad arguments and unknown tools are reported to the model, not thrown', async () => {
  const run = await runAgent({
    model: new ScriptedModel([
      { tools: [{ name: 'lookup_order', input: { orderId: 1001 } }, { name: 'drop_tables', input: {} }] },
      final,
    ]),
    input: 'x',
    traceId: 't',
  });
  const spans = run.spans.filter((s) => s.attributes?.['gen_ai.operation.name'] === 'execute_tool');
  expect(spans.map((s) => s.attributes?.['gen_ai.tool.status'])).toEqual(['error', 'error']);
  expect(String(spans[1]!.attributes?.['gen_ai.tool.call.result'])).toMatch(/unknown tool drop_tables/);
});

test('the run stops at maxTurns without a final answer', async () => {
  const loop = Array.from({ length: 5 }, () => ({ tools: [{ name: 'lookup_order', input: { orderId: 'A-1001' } }] }));
  const run = await runAgent({ model: new ScriptedModel(loop), input: 'x', traceId: 't', maxTurns: 3 });
  expect(run.error).toBe('no final answer after 3 turns');
  expect(readTraces(run.spans).get('t')!.response).toBeUndefined();
});

test('a tool_use stop with no tool calls is an error, not an endless loop', async () => {
  const model: ModelClient = {
    modelId: 'odd',
    converse: () => Promise.resolve({ message: { role: 'assistant', content: [{ text: 'hmm' }] }, stopReason: 'tool_use' }),
  };
  const run = await runAgent({ model, input: 'x', traceId: 't' });
  expect(run.error).toMatch(/no tool calls/);
});

test('an unexpected exception inside a tool is not swallowed', async () => {
  const model = new ScriptedModel([{ tools: [{ name: 'lookup_order', input: { orderId: 'A-1001' } }] }, final]);
  const store = { get: () => { throw new TypeError('disk on fire'); } } as never;
  await expect(runAgent({ model, input: 'x', traceId: 't', store })).rejects.toThrow('disk on fire');
});

test('the model sees each tool with a JSON Schema built from the zod schema', () => {
  const tools = toolConfig().tools!;
  expect(tools.map((t) => t.toolSpec!.name)).toEqual(['lookup_order', 'issue_refund', 'escalate_to_human']);
  const schema = tools[1]!.toolSpec!.inputSchema!.json as Record<string, unknown>;
  expect(schema).toMatchObject({ type: 'object', required: ['orderId', 'amount', 'reason'], additionalProperties: false });
});
