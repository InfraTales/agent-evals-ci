import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { AgentEvalsStack } from '../../infra/lib/evals-stack';

// Synthesize once, find the evaluator's bundled asset, and test the file Lambda will run.
const { context } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8'));
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
const app = new cdk.App({ context, outdir });
const stack = new AgentEvalsStack(app, 'Bundle', {
  agentLogGroupName: '/aws/x',
  agentServiceName: 'x.DEFAULT',
  judgeModelId: 'amazon.nova-lite-v1:0',
  samplingPercentage: 10,
  enabled: false,
  env: { account: '123456789012', region: 'us-east-1' },
});
const asm = app.synth();
const template = asm.getStackByName(stack.stackName).template;
const fnId = Object.keys(template.Resources).find((k) => template.Resources[k].Type === 'AWS::Lambda::Function' && k.startsWith('PolicyChecksFn'))!;
// The code's S3 key is <asset hash>.zip, and the staged asset lives in asset.<hash>.
const hash = String(template.Resources[fnId].Properties.Code.S3Key).replace(/\.zip$/, '');
const assetDir = path.join(asm.directory, `asset.${hash}`);

test('the bundle imports nothing from outside except Node built-ins (zod is inside)', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(assetDir, 'index.meta.json'), 'utf8'));
  // esbuild keys outputs by the temporary build path, so match on the file name.
  const key = Object.keys(meta.outputs).find((k) => k.endsWith('/index.js'))!;
  const out = meta.outputs[key];
  const external = out.imports.filter((i: { path: string; external?: boolean }) => i.external && !i.path.startsWith('node:'));
  expect(external).toEqual([]);
  expect(Object.keys(out.inputs).some((p) => p.includes('node_modules/zod/'))).toBe(true);
});

test('the bundle loads in a fresh Node process and returns PASS for a good trace', () => {
  const event = {
    schemaVersion: '1.0',
    evaluationLevel: 'TRACE',
    evaluationInput: { sessionSpans: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'strands-unified.json'), 'utf8')) },
    evaluationTarget: { traceIds: ['69e9cc4771d7cabe0d8e8cea33b6b338'] },
  };
  const script = `require(${JSON.stringify(path.join(assetDir, 'index.js'))}).handler(${JSON.stringify(event)}).then(r => process.stdout.write('\\n' + JSON.stringify(r)))`;
  // A clean cwd and no NODE_PATH, so the bundle can't borrow this repo's node_modules.
  const out = execFileSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), env: { PATH: process.env.PATH }, timeout: 20000 }).toString();
  expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ label: 'PASS', value: 1, explanation: 'All 5 policy checks passed.' });
});
