# Cost

Prices are for us-east-1, taken from the AWS Price List API and the AgentCore pricing page on 2026-10-16. Check them again before you rely on them.

## CI in stub mode: $0

The scripted model makes no AWS calls. GitHub Actions minutes are the only cost, and public repositories get them free.

## CI in live mode: about 1 to 2 cents a run

A live run sends 8 cases × 5 trials = 40 conversations to the model. The token counts below are assumptions: 3 model calls per conversation, 1,500 input and 100 output tokens per call. The eval report prints the real totals after each run, so replace them with yours.

| Model | Input price | Output price | One run (180,000 in, 12,000 out) |
|---|---|---|---|
| Amazon Nova Micro (`amazon.nova-micro-v1:0`) | $0.035 per 1M tokens | $0.14 per 1M tokens | $0.008 |
| Amazon Nova Lite (`amazon.nova-lite-v1:0`) | $0.06 per 1M tokens | $0.24 per 1M tokens | $0.014 |

A weekly run plus 20 manual runs a month on Nova Lite comes to about $0.33. Test with the model you ship, though. A cheaper model passing your evals tells you nothing about the expensive one.

## Online evaluation in production

AgentCore Evaluations has no free tier. It bills in two ways:

| Item | Price | Notes |
|---|---|---|
| Built-in evaluators | $2.40 per 1M input tokens, $12.00 per 1M output tokens | Model cost is included |
| Custom evaluators | $0.0015 per evaluation ($1.50 per 1,000) | The judge's model tokens are billed separately by Amazon Bedrock |
| Batch evaluation | 25% off the built-in rates | Not used by this stack |

The example month below uses assumed traffic and token counts:

- 10,000 sessions a month at 10% sampling is 1,000 evaluated sessions.
- 1.5 traces per session is 1,500 traces, with 2 tool calls per trace for 3,000 tool calls.
- Each LLM evaluation reads 2,500 tokens and writes 200.

| Evaluator | Runs per | Evaluations | Monthly |
|---|---|---|---|
| Policy checks (code-based, trace level) | trace | 1,500 | $2.25 |
| Reply judge (custom, trace level) | trace | 1,500 | $2.25, plus $0.30 of Nova Lite tokens |
| `Builtin.GoalSuccessRate` | session | 1,000 | $8.40 |
| `Builtin.ToolSelectionAccuracy` | tool call | 3,000 | $25.20 |
| Evaluator Lambda (256 MB, about 0.2 s) | trace | 1,500 | $0.00, inside the Lambda free tier |
| **Total** | | | **about $38.40** |

Three things stand out:

1. The tool-level built-in costs the most, because it runs once per tool call rather than once per trace. Drop it, or lower the sampling rate, before you cut anything else.
2. The pricing page doesn't say whether code-based evaluators count as custom evaluators. The table assumes they do. If they don't, the policy-checks line drops to about $0.
3. Evaluations need CloudWatch Transaction Search. Spans cost $0.35 per GB ingested (first 10 TB), and indexing is free for the first 1% of spans, then $0.75 per million. New accounts get 3 months free, up to 100 GB ingested and 1 million spans indexed.

The online config starts `DISABLED` for this reason. Deploying it costs nothing until you turn it on.
