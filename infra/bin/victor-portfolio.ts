#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VictorPortfolioCertStack } from '../lib/victor-portfolio-cert-stack.js';
import { VictorPortfolioFoundationStack } from '../lib/victor-portfolio-stack.js';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

if (!account) {
  throw new Error('CDK_DEFAULT_ACCOUNT was not set. Run with an AWS profile/account.');
}

const certStack = new VictorPortfolioCertStack(app, 'VictorPortfolioCertStack', {
  env: {
    account,
    region: 'us-east-1'
  },
  crossRegionReferences: true
});

const foundationStack = new VictorPortfolioFoundationStack(app, 'VictorPortfolioFoundationStack', {
  env: {
    account,
    region: 'us-west-2'
  },
  crossRegionReferences: true,
  certificate: certStack.certificate
});

foundationStack.addDependency(certStack);
