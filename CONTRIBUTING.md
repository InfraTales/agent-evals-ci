# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you open a pull request

1. Run `npm ci`, then `npm run check`. It must pass.
2. If you changed a check, the gate or the evaluator, run `npm run mutate` too. It has to kill every mutant. If you add a safeguard, add a mutant for it in `scripts/mutation-check.ts`.
3. Keep the CDK tests honest. They synthesize with the feature flags in `cdk.json`, the same ones a deploy uses.

## Adding an eval case

Add it to `evals/cases.json`. Give it at least one stub script, mark it `critical` if one failure should block a merge, then run `npm run evals -- --update-baseline` and commit the new baseline with the case. A reviewer should see both changes in the same diff.

Never delete a case to make CI pass. The gate fails when a case in the baseline doesn't run, so a deletion needs a baseline change that a reviewer can question.

## Style

TypeScript with strict settings and type-checked ESLint. Comments explain why, not what. Docs use short sentences and plain words.

## License

By contributing, you agree to release your work under the MIT No Attribution license in [LICENSE](LICENSE).
