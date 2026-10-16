#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentEvalsStack } from '../lib/evals-stack';

const app = new cdk.App();

function ctx(name: string, fallback?: string): string {
  const v: unknown = app.node.tryGetContext(name) ?? fallback;
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`Pass -c ${name}=... (see README)`);
  return v;
}

new AgentEvalsStack(app, 'AgentEvals', {
  // Defaults let `cdk synth` run in CI. Point them at your agent before you deploy.
  agentLogGroupName: ctx('agentLogGroupName', '/aws/bedrock-agentcore/runtimes/order_support-DEFAULT'),
  agentServiceName: ctx('agentServiceName', 'order_support.DEFAULT'),
  judgeModelId: ctx('judgeModelId', 'amazon.nova-lite-v1:0'),
  samplingPercentage: Number(ctx('samplingPercentage', '10')),
  enabled: ctx('enabled', 'false') === 'true',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
