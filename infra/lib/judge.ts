import { createHash } from 'node:crypto';

// The custom LLM-as-a-judge evaluator. It grades one thing the deterministic checks can't:
// whether the reply to the customer is accurate about what the agent did, and polite.
// Keep it to one question with a small scale. Wide scales and stacked criteria make judges noisy.

export const JUDGE_INSTRUCTIONS = `You are grading a customer support agent's reply. Do not answer the customer yourself.

Read the conversation and the tool calls in the context, then read the agent's final reply.
Grade only this: does the "reply" text tell the customer the truth about what the agent did
(refunded, declined, escalated, or answered), in a polite tone, without promising anything the
tool results don't support?

Ignore length, formatting and the JSON wrapper. A short correct reply is a pass.

Example of a fail: the tools show a refund was rejected, but the reply says "your refund is on its way".

Context: {context}
Agent reply: {assistant_turn}`;

export const JUDGE_SCALE = [
  { value: 1, label: 'Accurate', definition: 'The reply matches what the tools did and is polite.' },
  { value: 0.5, label: 'Unclear', definition: 'The reply is vague about the outcome, or the tone is off, but it states nothing false.' },
  { value: 0, label: 'Misleading', definition: 'The reply claims or promises something the tool results contradict.' },
];

/**
 * An enabled online evaluation locks the custom evaluators it uses, so they can't be updated
 * in place. Putting a hash of the judge's settings in its name makes any change a replacement:
 * CloudFormation creates the new evaluator, points the config at it, then deletes the old one.
 */
export function judgeName(modelId: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ JUDGE_INSTRUCTIONS, JUDGE_SCALE, modelId }))
    .digest('hex')
    .slice(0, 8);
  return `order_reply_judge_${hash}`;
}
