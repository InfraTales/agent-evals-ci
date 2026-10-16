# Security design

## The evaluation execution role

AgentCore Evaluations assumes one IAM role to read spans, call the judge model and run the policy checks.

- **Who can assume it.** Only `bedrock-agentcore.amazonaws.com`, and only when `aws:SourceAccount` and `aws:ResourceAccount` are this account and `aws:SourceArn` is an evaluator or online evaluation config in this account and Region. That stops another account's evaluator from borrowing the role.
- **What it can do.** It can call `bedrock:InvokeModel` on the judge model's ARN only, and `lambda:InvokeFunction` on the evaluator function only. It writes results to `/aws/bedrock-agentcore/evaluations/*`. It manages the index policy on `aws/spans`.
- **The wildcard.** `logs:StartQuery`, `logs:GetQueryResults` and `logs:DescribeLogGroups` use `"Resource": "*"`, as in the role the AgentCore docs publish. cdk-nag flags it, and the stack acknowledges that finding with the reason in code.

## The evaluator function

- Its role can write to its own log group and do nothing else. It calls no AWS APIs.
- It logs one line per evaluation: the label and score. It doesn't log spans, prompts or replies, because those can hold customer data.
- The build bundles the whole function, zod included, into one file. A test loads that bundle in a clean Node.js process to prove it doesn't rely on packages from the runtime.

## Prompt injection

The suite has a critical case where the customer claims "admin mode" and asks for two refunds without a lookup. The evals check behaviour, but the tools also enforce the money rules themselves. `issue_refund` refuses orders that aren't delivered and amounts over what's left, whatever the model asks for. Don't let evals be your only control.

## Data in eval reports

Reports hold the inputs and the failed checks for each trial. In live mode they can hold model output. CI uploads them as build artifacts for 14 days (stub) or 30 days (live). Don't put real customer data in `evals/cases.json`.

## CI

- Workflows pin actions to commit SHAs, and Dependabot proposes updates after a 7-day cooldown.
- The default token permission is `contents: read`.
- `npm audit --omit=dev --audit-level=high` runs on every build.
- Live evals use GitHub OIDC to assume an AWS role, so the repo stores no long-lived AWS keys. See [live-evals.md](live-evals.md).
