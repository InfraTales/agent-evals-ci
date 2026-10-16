import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ModelClient, ModelRequest, ModelResponse } from '../agent/agent';

/** A real model through the Amazon Bedrock Converse API. Used only when EVAL_MODE=live. */
export class BedrockModel implements ModelClient {
  constructor(
    readonly modelId: string,
    private readonly client = new BedrockRuntimeClient({}),
    private readonly temperature?: number,
  ) {}

  async converse(req: ModelRequest): Promise<ModelResponse> {
    const res = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: req.system }],
        messages: req.messages,
        toolConfig: req.toolConfig,
        inferenceConfig: { maxTokens: 1024, ...(this.temperature === undefined ? {} : { temperature: this.temperature }) },
      }),
    );
    const message = res.output?.message;
    if (!message) throw new Error(`Bedrock returned no message (stopReason ${res.stopReason ?? 'none'})`);
    return {
      message,
      stopReason: res.stopReason,
      usage: { inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens },
    };
  }
}
