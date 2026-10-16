import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentEvalsStack, type AgentEvalsStackProps } from '../../infra/lib/evals-stack';
import { judgeName } from '../../infra/lib/judge';

// Synthesize with the feature flags from cdk.json, the same ones `cdk deploy` uses.
const { context } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8'));
const newApp = (outdir?: string): cdk.App => new cdk.App({ context, ...(outdir ? { outdir } : {}) });

const env = { account: '123456789012', region: 'us-east-1' };
const props: AgentEvalsStackProps = {
  agentLogGroupName: '/aws/bedrock-agentcore/runtimes/order_support-DEFAULT',
  agentServiceName: 'order_support.DEFAULT',
  judgeModelId: 'amazon.nova-lite-v1:0',
  samplingPercentage: 10,
  enabled: false,
  env,
};
const synth = (over: Partial<AgentEvalsStackProps> = {}, id = 'T'): Template =>
  Template.fromStack(new AgentEvalsStack(newApp(), id, { ...props, ...over }));

const template = synth();
const one = (type: string): any => Object.values<any>(template.findResources(type))[0].Properties;
const evaluators = (): any[] => Object.values<any>(template.findResources('AWS::BedrockAgentCore::Evaluator')).map((r) => r.Properties);

test('the evaluator function is arm64 on Node.js 24 with its own log group', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Architectures: ['arm64'],
    Timeout: 30,
    LoggingConfig: { LogGroup: Match.anyValue() },
  });
  template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
});

test('the code-based evaluator points at the function with the same timeout', () => {
  const code = evaluators().find((e) => e.EvaluatorConfig.CodeBased)!;
  expect(code.Level).toBe('TRACE');
  expect(code.EvaluatorConfig.CodeBased.LambdaConfig).toEqual({
    LambdaArn: { 'Fn::GetAtt': [expect.stringMatching(/^PolicyChecksFn/), 'Arn'] },
    LambdaTimeoutInSeconds: one('AWS::Lambda::Function').Timeout,
  });
});

test('evaluator and config names fit the CloudFormation pattern (no hyphens)', () => {
  const pattern = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
  for (const e of evaluators()) expect(e.EvaluatorName).toMatch(pattern);
  expect(one('AWS::BedrockAgentCore::OnlineEvaluationConfig').OnlineEvaluationConfigName).toMatch(pattern);
});

test('the judge runs at temperature 0 on the chosen model with a 3-point scale', () => {
  const judge = evaluators().find((e) => e.EvaluatorConfig.LlmAsAJudge)!.EvaluatorConfig.LlmAsAJudge;
  expect(judge.ModelConfig.BedrockEvaluatorModelConfig).toEqual({ ModelId: 'amazon.nova-lite-v1:0', InferenceConfig: { Temperature: 0, MaxTokens: 512 } });
  expect(judge.RatingScale.Numerical.map((s: any) => s.Value)).toEqual([1, 0.5, 0]);
  expect(judge.Instructions).toContain('{context}');
  expect(judge.Instructions).toContain('{assistant_turn}');
});

test('changing the judge model renames the judge, so an enabled config never needs an in-place update', () => {
  expect(judgeName('amazon.nova-lite-v1:0')).not.toBe(judgeName('amazon.nova-micro-v1:0'));
  expect(judgeName('amazon.nova-lite-v1:0')).toBe(judgeName('amazon.nova-lite-v1:0'));
});

test('online evaluation samples 10%, reads the agent log group, and starts disabled', () => {
  const cfg = one('AWS::BedrockAgentCore::OnlineEvaluationConfig');
  expect(cfg.ExecutionStatus).toBe('DISABLED');
  expect(cfg.Rule).toEqual({ SamplingConfig: { SamplingPercentage: 10 }, SessionConfig: { SessionTimeoutMinutes: 15 } });
  expect(cfg.DataSourceConfig.CloudWatchLogs).toEqual({ LogGroupNames: [props.agentLogGroupName], ServiceNames: [props.agentServiceName] });
  const ids = cfg.Evaluators.map((e: any) => e.EvaluatorId);
  expect(ids).toHaveLength(4);
  expect(ids).toEqual(expect.arrayContaining(['Builtin.GoalSuccessRate', 'Builtin.ToolSelectionAccuracy']));
  const on = Object.values<any>(synth({ enabled: true }, 'On2').findResources('AWS::BedrockAgentCore::OnlineEvaluationConfig'))[0];
  expect(on.Properties.ExecutionStatus).toBe('ENABLED');
});

test('sampling outside 0.01 to 100 percent is rejected at synth', () => {
  expect(() => synth({ samplingPercentage: 0 }, 'Low')).toThrow('between 0.01 and 100');
  expect(() => synth({ samplingPercentage: 101 }, 'High')).toThrow('between 0.01 and 100');
});

test('only AgentCore Evaluations, for this account and Region, can assume the execution role', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        {
          Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
          Condition: {
            StringEquals: { 'aws:SourceAccount': '123456789012', 'aws:ResourceAccount': '123456789012' },
            ArnLike: {
              'aws:SourceArn': [
                'arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/*',
                'arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/*',
              ],
            },
          },
        },
      ],
    },
  });
});

test('the execution role can call only the judge model and only the evaluator function', () => {
  const policies = Object.values<any>(template.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
  const bedrock = policies.find((s) => s.Sid === 'InvokeJudge');
  expect(bedrock.Resource).toBe('arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0');
  const invoke = policies.find((s) => s.Sid === 'RunPolicyChecks');
  expect(invoke.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^PolicyChecksFn/), 'Arn'] });
  // Nothing grants a wildcard Bedrock or Lambda action.
  for (const s of policies) for (const a of [s.Action].flat()) expect(a).not.toMatch(/^(bedrock|lambda):\*$/);
});

test('the function role writes to its own log group and has no managed policies', () => {
  const role = Object.entries<any>(template.findResources('AWS::IAM::Role')).find(([id]) => id.startsWith('PolicyChecksFnRole'))![1];
  expect(role.Properties.ManagedPolicyArns).toBeUndefined();
});

test('cdk-nag AWS Solutions finds nothing unacknowledged, with a concrete or a token account', () => {
  for (const stackEnv of [env, { region: 'us-east-1' }, {}]) {
    const app = newApp(fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')));
    new AgentEvalsStack(app, 'Nag', { ...props, env: stackEnv });
    cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    const assembly = app.synth();
    const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
    for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
  }
});

describe('a judge on a cross-Region inference profile', () => {
  const judgeStatements = (t: Template): any[] =>
    Object.values<any>(t.findResources('AWS::IAM::Policy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s) => String(s.Sid).startsWith('InvokeJudge'));

  test('a geographic profile grants the profile, and the model in any Region only through it', () => {
    const s = judgeStatements(synth({ judgeModelId: 'us.amazon.nova-lite-v1:0' }, 'Geo'));
    const profileArn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-lite-v1:0';
    expect(s.find((x) => x.Sid === 'InvokeJudge').Resource).toBe(profileArn);
    const model = s.find((x) => x.Sid === 'InvokeJudgeThroughProfile');
    expect(model.Resource).toBe('arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0');
    expect(model.Condition).toEqual({ StringLike: { 'bedrock:InferenceProfileArn': profileArn } });
  });

  test('a global profile grants the source-Region and the Region-less model ARN, only through the profile', () => {
    const s = judgeStatements(synth({ judgeModelId: 'global.anthropic.claude-haiku-5-5' }, 'Global'));
    const profileArn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-haiku-5-5';
    expect(s.find((x) => x.Sid === 'InvokeJudge').Resource).toBe(profileArn);
    const model = s.find((x) => x.Sid === 'InvokeJudgeThroughProfile');
    expect([...model.Resource].sort()).toEqual([
      'arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-5-5',
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5',
    ]);
    expect(model.Condition).toEqual({ StringLike: { 'bedrock:InferenceProfileArn': profileArn } });
  });

  test('an in-Region model ID still gets exactly one ARN', () => {
    const s = judgeStatements(template);
    expect(s).toHaveLength(1);
  });

  test('cdk-nag stays clean with either kind of profile, with a concrete or a token account', () => {
    for (const judgeModelId of ['us.amazon.nova-lite-v1:0', 'global.anthropic.claude-haiku-5-5']) {
      for (const stackEnv of [env, {}]) {
        const app = newApp(fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')));
        new AgentEvalsStack(app, 'NagProfile', { ...props, judgeModelId, env: stackEnv });
        cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
        const assembly = app.synth();
        const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
        for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
      }
    }
  });
});
