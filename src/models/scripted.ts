import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { ModelClient, ModelRequest, ModelResponse } from '../agent/agent';

/** One model turn in a script: some tool calls, or a final answer. */
export type ScriptTurn =
  | { tools: { name: string; input: unknown }[] }
  | { final: string }
  | { finalJson: unknown };

/**
 * Replays a fixed script. It stands in for the model in CI, so every pull request tests the
 * agent loop, the tools, the checks and the gate for free and gets the same answer each time.
 * It does not test the model's judgement. Live mode does that.
 */
export class ScriptedModel implements ModelClient {
  readonly modelId = 'scripted';
  private turn = 0;

  constructor(private readonly script: readonly ScriptTurn[]) {}

  converse(_req: ModelRequest): Promise<ModelResponse> {
    const step = this.script[this.turn++];
    if (!step) return Promise.reject(new Error(`script ran out after ${this.script.length} turns`));
    if ('tools' in step) {
      const content: ContentBlock[] = step.tools.map((t, i) => ({
        toolUse: { toolUseId: `tooluse_${this.turn}_${i}`, name: t.name, input: t.input as never },
      }));
      return Promise.resolve({ message: { role: 'assistant', content }, stopReason: 'tool_use' });
    }
    const text = 'final' in step ? step.final : JSON.stringify(step.finalJson);
    return Promise.resolve({ message: { role: 'assistant', content: [{ text }] }, stopReason: 'end_turn' });
  }
}
