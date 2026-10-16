import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { JUDGE_INSTRUCTIONS, JUDGE_SCALE, judgeName } from './judge';

export interface AgentEvalsStackProps extends cdk.StackProps {
  /** Log group that holds the agent's spans, for example /aws/bedrock-agentcore/runtimes/<agent_id>-DEFAULT. */
  readonly agentLogGroupName: string;
  /** The agent's OpenTelemetry service name. On AgentCore Runtime: <agent-runtime-name>.<endpoint-name>. */
  readonly agentServiceName: string;
  /**
   * Bedrock model the custom judge runs on. An in-Region model ID keeps the IAM grant to one ARN.
   * A cross-Region inference profile ID (us., eu., global. ...) also works: the role then gets
   * the profile and the model in the Regions it routes to.
   */
  readonly judgeModelId: string;
  /** Share of sessions to evaluate, 0.01 to 100. */
  readonly samplingPercentage: number;
  /** Start evaluating on deploy. Off by default: online evaluation bills per evaluation. */
  readonly enabled: boolean;
}

// The checks need the whole trace. The function's timeout and the evaluator's must agree,
// or AgentCore gives up on an invocation the function would have finished.
const EVALUATOR_TIMEOUT = cdk.Duration.seconds(30);

export class AgentEvalsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentEvalsStackProps) {
    super(scope, id, props);
    if (props.samplingPercentage < 0.01 || props.samplingPercentage > 100) {
      throw new Error(`samplingPercentage must be between 0.01 and 100, got ${props.samplingPercentage}`);
    }

    // 1. The code-based evaluator: the same policy checks CI runs, as a Lambda function.
    const logGroup = new logs.LogGroup(this, 'PolicyChecksLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fnRole = new iam.Role(this, 'PolicyChecksFnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Writes logs for the policy checks evaluator, and nothing else',
    });
    logGroup.grantWrite(fnRole);
    const fn = new NodejsFunction(this, 'PolicyChecksFn', {
      entry: path.join(__dirname, '..', '..', 'src', 'evaluator', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: EVALUATOR_TIMEOUT,
      role: fnRole,
      logGroup,
      // Bundle everything, zod included. The checks must not depend on what the runtime ships.
      bundling: { externalModules: [], minify: true, sourceMap: true, metafile: true, format: OutputFormat.CJS },
      environment: { NODE_OPTIONS: '--enable-source-maps' },
    });

    // 2. The role AgentCore Evaluations assumes to read spans, call the judge and run the checks.
    const { account, region, partition } = cdk.Stack.of(this);
    const execRole = new iam.Role(this, 'EvaluationExecutionRole', {
      description: 'Assumed by AgentCore Evaluations for this stack only',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account, 'aws:ResourceAccount': account },
          ArnLike: {
            'aws:SourceArn': [
              `arn:${partition}:bedrock-agentcore:${region}:${account}:evaluator/*`,
              `arn:${partition}:bedrock-agentcore:${region}:${account}:online-evaluation-config/*`,
            ],
          },
        },
      }),
    });
    execRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSpans',
        // Logs Insights queries don't support resource-level permissions.
        actions: ['logs:DescribeLogGroups', 'logs:GetQueryResults', 'logs:StartQuery'],
        resources: ['*'],
      }),
    );
    execRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteResults',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/evaluations/*`],
      }),
    );
    execRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IndexSpans',
        actions: ['logs:DescribeIndexPolicies', 'logs:PutIndexPolicy'],
        resources: [
          `arn:${partition}:logs:${region}:${account}:log-group:aws/spans`,
          `arn:${partition}:logs:${region}:${account}:log-group:aws/spans:*`,
        ],
      }),
    );
    const judgeGrant = judgeModelGrant(props.judgeModelId, partition, region, account);
    for (const statement of judgeGrant.statements) execRole.addToPolicy(statement);
    execRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunPolicyChecks',
        actions: ['lambda:InvokeFunction', 'lambda:GetFunction'],
        resources: [fn.functionArn],
      }),
    );

    const policyChecks = new agentcore.CfnEvaluator(this, 'PolicyChecksEvaluator', {
      evaluatorName: 'order_policy_checks',
      description: 'Deterministic policy checks shared with CI: tool arguments, lookup before refund, one refund, output schema',
      level: 'TRACE',
      evaluatorConfig: {
        codeBased: { lambdaConfig: { lambdaArn: fn.functionArn, lambdaTimeoutInSeconds: EVALUATOR_TIMEOUT.toSeconds() } },
      },
    });

    // 3. A custom LLM judge for the one question code can't answer: is the reply truthful and polite?
    const judge = new agentcore.CfnEvaluator(this, 'ReplyJudge', {
      evaluatorName: judgeName(props.judgeModelId),
      description: 'Does the reply tell the customer the truth about what the agent did?',
      level: 'TRACE',
      evaluatorConfig: {
        llmAsAJudge: {
          instructions: JUDGE_INSTRUCTIONS,
          ratingScale: { numerical: JUDGE_SCALE },
          // Temperature 0 makes the judge as repeatable as it gets. It is still a model.
          modelConfig: { bedrockEvaluatorModelConfig: { modelId: props.judgeModelId, inferenceConfig: { temperature: 0, maxTokens: 512 } } },
        },
      },
    });

    // 4. Online evaluation: sample live sessions and score them with all four evaluators.
    const online = new agentcore.CfnOnlineEvaluationConfig(this, 'OnlineEvaluation', {
      onlineEvaluationConfigName: 'order_support_online',
      description: 'Samples live order-support sessions',
      evaluationExecutionRoleArn: execRole.roleArn,
      executionStatus: props.enabled ? 'ENABLED' : 'DISABLED',
      dataSourceConfig: {
        cloudWatchLogs: { logGroupNames: [props.agentLogGroupName], serviceNames: [props.agentServiceName] },
      },
      rule: {
        samplingConfig: { samplingPercentage: props.samplingPercentage },
        sessionConfig: { sessionTimeoutMinutes: 15 },
      },
      evaluators: [
        { evaluatorId: policyChecks.attrEvaluatorId },
        { evaluatorId: judge.attrEvaluatorId },
        { evaluatorId: agentcore.BuiltinEvaluator.GOAL_SUCCESS_RATE.value },
        { evaluatorId: agentcore.BuiltinEvaluator.TOOL_SELECTION_ACCURACY.value },
      ],
    });
    // The service checks it can assume the role and call the function when the config is created.
    online.node.addDependency(execRole);

    new cdk.CfnOutput(this, 'OnlineEvaluationConfigId', { value: online.attrOnlineEvaluationConfigId });
    new cdk.CfnOutput(this, 'PolicyChecksEvaluatorId', { value: policyChecks.attrEvaluatorId });
    new cdk.CfnOutput(this, 'ReplyJudgeEvaluatorId', { value: judge.attrEvaluatorId });

    // cdk-nag prints ARNs with concrete values where the stack has them, tokens elsewhere.
    // Build the finding IDs from the stack's real values so the acknowledgements keep matching.
    const show = (v: string, token: string): string => (cdk.Token.isUnresolved(v) ? token : v);
    const logsArn = `arn:${show(partition, '<AWS::Partition>')}:logs:${show(region, '<AWS::Region>')}:${show(account, '<AWS::AccountId>')}:log-group:`;
    const ack = (resource: string, reason: string): void =>
      cdk.Validations.of(execRole).acknowledge({ id: `AwsSolutions::AwsSolutions-IAM5[Resource::${resource}]`, reason });
    ack('*', 'logs:StartQuery, GetQueryResults and DescribeLogGroups need "*". This matches the AgentCore Evaluations service role in the AWS docs.');
    ack(`${logsArn}/aws/bedrock-agentcore/evaluations/*`, 'AgentCore Evaluations writes results to log groups it names under this prefix.');
    ack(`${logsArn}aws/spans:*`, 'The service manages the index policy on the aws/spans log group and its streams.');
    if (judgeGrant.anyRegionModelArn) {
      ack(
        judgeGrant.anyRegionModelArn.replace(partition, show(partition, '<AWS::Partition>')),
        'A geographic inference profile can route to any Region in its geography. The grant only works through this profile (bedrock:InferenceProfileArn condition).',
      );
    }
  }
}

const JUDGE_ACTIONS = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];
const PROFILE_ID = /^(us|eu|apac|jp|au|ca|us-gov|global)\.(.+)$/;

/**
 * IAM for the judge model. An in-Region model ID needs one foundation-model ARN. A
 * cross-Region inference profile ID (us., eu., global. ...) needs the profile ARN plus the
 * model in every Region the profile can route to, as the Bedrock inference profile
 * prerequisites page shows. Those model grants only work through the profile.
 */
export function judgeModelGrant(
  modelId: string,
  partition: string,
  region: string,
  account: string,
): { statements: iam.PolicyStatement[]; anyRegionModelArn?: string } {
  const profile = PROFILE_ID.exec(modelId);
  if (!profile) {
    return {
      statements: [new iam.PolicyStatement({ sid: 'InvokeJudge', actions: JUDGE_ACTIONS, resources: [`arn:${partition}:bedrock:${region}::foundation-model/${modelId}`] })],
    };
  }
  const [, geo, baseModel] = profile;
  const profileArn = `arn:${partition}:bedrock:${region}:${account}:inference-profile/${modelId}`;
  // Global profiles route anywhere: the docs grant the source-Region model and the Region-less model ARN.
  const anyRegionModelArn = geo === 'global' ? undefined : `arn:${partition}:bedrock:*::foundation-model/${baseModel}`;
  const modelArns =
    geo === 'global'
      ? [`arn:${partition}:bedrock:${region}::foundation-model/${baseModel}`, `arn:${partition}:bedrock:::foundation-model/${baseModel}`]
      : [anyRegionModelArn as string];
  return {
    anyRegionModelArn,
    statements: [
      new iam.PolicyStatement({ sid: 'InvokeJudge', actions: JUDGE_ACTIONS, resources: [profileArn] }),
      new iam.PolicyStatement({
        sid: 'InvokeJudgeThroughProfile',
        actions: JUDGE_ACTIONS,
        resources: modelArns,
        conditions: { StringLike: { 'bedrock:InferenceProfileArn': profileArn } },
      }),
    ],
  };
}
