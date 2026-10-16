import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { runAgent } from '../../src/agent/agent';
import { policyChecks } from '../../src/evals/checks';
import { readTraces } from '../../src/evals/spans';
import { BedrockModel } from '../../src/models/bedrock';

const bedrock = mockClient(BedrockRuntimeClient);
beforeEach(() => bedrock.reset());

test('live mode sends the system prompt, tools and history to Converse and follows tool_use', async () => {
  bedrock
    .on(ConverseCommand)
    .resolvesOnce({
      stopReason: 'tool_use',
      output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu1', name: 'lookup_order', input: { orderId: 'A-1002' } } }] } },
      usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
    })
    .resolvesOnce({
      stopReason: 'end_turn',
      output: { message: { role: 'assistant', content: [{ text: '{"action":"answered","orderId":"A-1002","reply":"It has shipped."}' }] } },
      usage: { inputTokens: 1000, outputTokens: 30, totalTokens: 1030 },
    });

  const model = new BedrockModel('amazon.nova-lite-v1:0', new BedrockRuntimeClient({ region: 'us-east-1' }), 0);
  const run = await runAgent({ model, input: 'Where is A-1002?', traceId: 't' });

  const calls = bedrock.commandCalls(ConverseCommand);
  expect(calls).toHaveLength(2);
  const first = calls[0]!.args[0].input;
  expect(first.modelId).toBe('amazon.nova-lite-v1:0');
  expect(first.system![0]!.text).toMatch(/call lookup_order/);
  expect(first.toolConfig!.tools).toHaveLength(3);
  expect(first.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0 });
  const second = calls[1]!.args[0].input;
  expect(second.messages![2]!.content![0]!.toolResult).toMatchObject({ toolUseId: 'tu1', status: 'success' });

  expect(run.usage).toEqual({ inputTokens: 1900, outputTokens: 70 });
  const trace = readTraces(run.spans).get('t')!;
  expect(policyChecks(trace).every((r) => r.pass)).toBe(true);
  const chat = run.spans.find((s) => s.attributes?.['gen_ai.operation.name'] === 'chat')!;
  expect(chat.attributes).toMatchObject({ 'gen_ai.request.model': 'amazon.nova-lite-v1:0', 'gen_ai.usage.input_tokens': 900 });
});

test('a Converse response with no message is an error', async () => {
  bedrock.on(ConverseCommand).resolves({ stopReason: 'guardrail_intervened' });
  const model = new BedrockModel('m', new BedrockRuntimeClient({ region: 'us-east-1' }));
  await expect(model.converse({ system: 's', messages: [], toolConfig: { tools: [] } })).rejects.toThrow('guardrail_intervened');
});
