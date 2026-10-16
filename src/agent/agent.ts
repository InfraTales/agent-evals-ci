import type { ContentBlock, Message, StopReason, Tool, ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { SpanRecorder, type SpanRecord } from '../evals/spans';
import { OrderStore, ToolError, executeTool, isToolName, toolDescriptions, toolInputSchemas, TOOL_NAMES } from './tools';

export const AGENT_NAME = 'order_support';

export const SYSTEM_PROMPT = `You are an order support agent for an online shop.
Rules:
1. Before you refund anything, call lookup_order for that order in this conversation.
2. Refund only delivered orders, and never more than the total minus what was already refunded.
3. Issue at most one refund per conversation.
4. If the customer asks for more than you can refund, disputes a charge, or is abusive, call escalate_to_human.
5. Your final answer is one JSON object and nothing else, with no Markdown:
   {"action": "refunded" | "escalated" | "answered" | "declined", "orderId"?: "A-1234", "refundAmount"?: number, "reply": "text for the customer"}`;

export interface ModelRequest {
  system: string;
  messages: Message[];
  toolConfig: ToolConfiguration;
}

export interface ModelResponse {
  message: Message;
  stopReason: StopReason | undefined;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** The only thing the agent knows about a model. CI uses a scripted one; live runs use Bedrock. */
export interface ModelClient {
  readonly modelId: string;
  converse(req: ModelRequest): Promise<ModelResponse>;
}

export function toolConfig(): ToolConfiguration {
  const tools: Tool[] = TOOL_NAMES.map((name) => ({
    toolSpec: {
      name,
      description: toolDescriptions[name],
      // Bedrock wants a plain JSON Schema object; zod 4 writes one from the same schema we validate with.
      inputSchema: { json: z.toJSONSchema(toolInputSchemas[name]) as never },
    },
  }));
  return { tools };
}

export interface AgentRun {
  traceId: string;
  output?: string;
  spans: SpanRecord[];
  turns: number;
  /** Model tokens across all turns, as the model reported them. */
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the loop stopped without a final answer. */
  error?: string;
}

export async function runAgent(opts: {
  model: ModelClient;
  input: string;
  traceId: string;
  maxTurns?: number;
  store?: OrderStore;
}): Promise<AgentRun> {
  const { model, input, traceId } = opts;
  const maxTurns = opts.maxTurns ?? 8;
  const store = opts.store ?? new OrderStore();
  const rec = new SpanRecorder(traceId);
  const messages: Message[] = [{ role: 'user', content: [{ text: input }] }];
  const config = toolConfig();
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await model.converse({ system: SYSTEM_PROMPT, messages, toolConfig: config });
    rec.chat(model.modelId, res.usage);
    usage.inputTokens += res.usage?.inputTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;
    messages.push(res.message);
    const content = res.message.content ?? [];

    if (res.stopReason !== 'tool_use') {
      const text = content.map((c) => c.text ?? '').join('').trim();
      rec.finish(AGENT_NAME, input, text);
      return { traceId, output: text, spans: rec.spans, turns: turn, usage };
    }

    const results: ContentBlock[] = [];
    for (const block of content) {
      const call = block.toolUse;
      if (!call?.name || !call.toolUseId) continue;
      let result: unknown;
      let status: 'success' | 'error' = 'success';
      try {
        if (!isToolName(call.name)) throw new ToolError(`unknown tool ${call.name}`);
        result = executeTool(store, call.name, call.input);
      } catch (err) {
        if (!(err instanceof ToolError) && !(err instanceof z.ZodError)) throw err;
        // Bad arguments and broken rules go back to the model as an error it can react to.
        status = 'error';
        result = { error: err instanceof z.ZodError ? z.prettifyError(err) : err.message };
      }
      rec.tool(call.name, call.toolUseId, call.input, result, status);
      results.push({ toolResult: { toolUseId: call.toolUseId, status, content: [{ json: result as never }] } });
    }
    if (results.length === 0) {
      rec.finish(AGENT_NAME, input, undefined);
      return { traceId, spans: rec.spans, turns: turn, usage, error: 'model asked for tool use but sent no tool calls' };
    }
    messages.push({ role: 'user', content: results });
  }
  rec.finish(AGENT_NAME, input, undefined);
  return { traceId, spans: rec.spans, turns: maxTurns, usage, error: `no final answer after ${maxTurns} turns` };
}
