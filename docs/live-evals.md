# Live evals in GitHub Actions

The `live-evals` workflow runs the suite against a real model on Amazon Bedrock. It runs when you start it by hand and every Monday at 06:00 UTC. It's skipped until you set it up.

## 1. Create an OIDC role in AWS

If your account doesn't trust GitHub's OIDC provider yet, add it first (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`). Then create a role with this trust policy. Replace the account ID and the repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:YOUR-ORG/agent-evals-ci:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

The `sub` condition limits it to runs on `main`. Give the role one permission. The Converse API needs `bedrock:InvokeModel` on the model you test:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0"
    }
  ]
}
```

## 2. Set repository variables

In **Settings → Secrets and variables → Actions → Variables**, set:

| Variable | Example |
|---|---|
| `AWS_EVALS_ROLE_ARN` | `arn:aws:iam::123456789012:role/agent-evals-ci-live` |
| `AWS_REGION` | `us-east-1` |
| `EVAL_MODEL_ID` | `amazon.nova-lite-v1:0` (used by the weekly run) |

## 3. Run it and set a baseline

Start the workflow from the **Actions** tab. The first runs have no baseline, so only the pass-rate minimum and the critical cases apply. After a few runs, run `npm run evals -- --update-baseline` on your machine with live settings, review the diff, and commit `evals/baseline.live.json`.

## Reading a failure

The job summary shows the pass rate per case and the first failing check. The full report is a build artifact. A failure in a critical case means at least one trial broke a hard rule. Read that trial before you rerun. An errored trial points to throttling or missing permissions in most cases, and the summary says which.
