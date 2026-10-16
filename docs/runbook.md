# Runbook

## The eval step fails in CI

Open the job summary. It lists each case, its pass rate and the first failing check.

| You see | It means | Do this |
|---|---|---|
| `critical case X failed` | A hard rule broke in at least one trial | Read the failed trial in the report. Fix the prompt, tool or code. Don't loosen the case |
| `pass rate ... below the ... minimum` | Many cases got worse | Look for a prompt or model change in the PR |
| `case X regressed from ... to ...` | One case dropped below its baseline | Same as above, for that case |
| `case X is in the baseline but did not run` | A case was removed or renamed | If that's intended, update the baseline in the same PR |
| `trial(s) errored` | The model call failed: throttling, permissions, a timeout | Rerun. If it repeats, check the error in the report |
| `no eval trials ran` | The cases file is empty or wasn't found | Check `evals/cases.json` |

## Changing the judge

Edit `infra/lib/judge.ts` and deploy. The judge's name includes a hash of its settings, so CloudFormation creates a new evaluator and moves the online config to it. The docs say an enabled config locks its custom evaluators, which would make an in-place update fail. Renaming avoids that. Nobody has tried this against a live account yet, so watch the first deploy.

## Changing the policy checks

Edit `src/evals/checks.ts`, run `npm run check` and `npm run mutate`, then deploy. The Lambda code changes, but the evaluator resource doesn't, so the lock doesn't get in the way.

## Turning online evaluation on or off

Deploy with `-c enabled=true` or `-c enabled=false`. It changes `ExecutionStatus` in place.

## Results show NOT_EVALUABLE

The evaluator returns an error, not a FAIL, when the spans lack tool arguments or the final reply. Check that observability and CloudWatch Transaction Search are on for the agent. With split telemetry, also check that the event records reach the agent's log group.

## Where results go

AgentCore Evaluations writes results to log groups under `/aws/bedrock-agentcore/evaluations/`. The evaluator function's own logs are in the log group the stack creates, kept for 30 days.
