#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';
import { FrontendAssetStack } from '../lib/frontend-asset-stack';

// Each stack lives in its own AWS account. Pinning env.account makes CDK
// refuse to deploy if the active profile points at the wrong account, which
// removes the "deployed to wrong account" footgun.
const REGION = 'us-west-1';

const app = new cdk.App();
new ImageOptimizationStack(app, 'ImgTransformationStack', {
  env: { account: '516314153244', region: REGION }, // grant-iam
});
new FrontendAssetStack(app, 'FrontendAssetStack', {
  env: { account: '230194004232', region: REGION }, // curate-admin
});

