import { z } from 'zod';
import { ORDER_ID } from './tools';

/** The agent's final answer must be this JSON object and nothing else. */
export const AgentOutput = z.strictObject({
  action: z.enum(['refunded', 'escalated', 'answered', 'declined']),
  orderId: ORDER_ID.optional(),
  refundAmount: z.number().positive().optional(),
  reply: z.string().min(1).max(1000),
});
export type AgentOutput = z.infer<typeof AgentOutput>;

export type ParsedOutput = { ok: true; value: AgentOutput } | { ok: false; error: string };

/** Strict on purpose: a reply wrapped in a Markdown code fence is a failure, not something to repair. */
export function parseAgentOutput(text: string | undefined): ParsedOutput {
  if (text === undefined) return { ok: false, error: 'no final response' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `final response is not JSON: ${text.slice(0, 60)}` };
  }
  const r = AgentOutput.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error) };
}
