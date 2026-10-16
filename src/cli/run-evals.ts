// Runs the eval suite and exits non-zero when the gate fails.
//   npm run evals                      stub mode: scripted model, free, same result every run
//   EVAL_MODE=live EVAL_MODEL_ID=... npm run evals   live mode: a real model on Amazon Bedrock
//   npm run evals -- --update-baseline write this run's pass rates as the new baseline
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireEnv } from '../config';
import { BedrockModel } from '../models/bedrock';
import { ScriptedModel } from '../models/scripted';
import { Baseline, CasesFile, GateConfig, readJson } from '../evals/cases';
import { gate, toBaseline } from '../evals/gate';
import { markdownReport } from '../evals/report';
import { runSuite, type ModelFactory } from '../evals/runner';

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const root = env.EVALS_DIR ?? join(__dirname, '..', '..', 'evals');
  const mode = env.EVAL_MODE ?? 'stub';
  if (mode !== 'stub' && mode !== 'live') throw new Error(`EVAL_MODE must be stub or live, not ${mode}`);

  const { cases } = readJson(join(root, 'cases.json'), CasesFile);
  const config = readJson(join(root, `config.${mode}.json`), GateConfig);
  const baselinePath = join(root, `baseline.${mode}.json`);
  const baseline = existsSync(baselinePath) ? readJson(baselinePath, Baseline) : undefined;

  let model: ModelFactory;
  let modelId: string;
  if (mode === 'live') {
    modelId = requireEnv('EVAL_MODEL_ID', env);
    model = () => new BedrockModel(modelId);
  } else {
    modelId = 'scripted';
    model = (c, trial) => new ScriptedModel(c.stub[trial % c.stub.length]!);
  }

  const result = await runSuite({ cases, trials: config.trials, mode, modelId, model, concurrency: mode === 'live' ? 2 : 4 });
  const verdict = gate(result, config, baseline);
  const md = markdownReport(result, verdict);

  const outDir = env.REPORTS_DIR ?? join(__dirname, '..', '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `eval-${mode}.json`), JSON.stringify({ result, verdict }, null, 2));
  writeFileSync(join(outDir, `eval-${mode}.md`), md);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  process.stdout.write(md);

  if (argv.includes('--update-baseline')) {
    writeFileSync(baselinePath, JSON.stringify(toBaseline(result), null, 2) + '\n');
    process.stdout.write(`\nWrote ${baselinePath}. Review the diff before you commit it.\n`);
  }
  return verdict.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(2);
    },
  );
}
