#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VictorPortfolioFoundationStack } from '../lib/victor-portfolio-stack.js';

const app = new cdk.App();
const certificateArn = app.node.tryGetContext('certificateArn') ?? process.env.CERTIFICATE_ARN;

if (!certificateArn || typeof certificateArn !== 'string') {
  throw new Error('Missing certificateArn. Pass -c certificateArn=arn:aws:acm:us-east-1:...');
}

new VictorPortfolioFoundationStack(app, 'VictorPortfolioFoundationStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2'
  },
  synthesizer: new cdk.CliCredentialsStackSynthesizer(),
  certificateArn
});
