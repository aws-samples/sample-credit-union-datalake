// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as signer from 'aws-cdk-lib/aws-signer';
import { SignedLambdaArtifact } from '../lib/signed-lambda-artifact';

const env = { account: '123456789012', region: 'us-west-2' };

function buildConstruct() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestSigningStack', { env });

  const key = new kms.Key(stack, 'Key', { enableKeyRotation: true });
  const artifactsBucket = SignedLambdaArtifact.createArtifactsBucket(stack, 'ArtifactsBucket', key);
  const signingProfile = new signer.SigningProfile(stack, 'Profile', {
    platform: signer.Platform.AWS_LAMBDA_SHA384_ECDSA,
  });

  const signed = new SignedLambdaArtifact(stack, 'SignedLayer', {
    artifactsBucket,
    signingProfile,
    // Reuse an existing asset directory so the test exercises directory-zip staging.
    assetPath: 'layers/pymysql',
  });

  return { stack, signed, template: Template.fromStack(stack) };
}

describe('SignedLambdaArtifact', () => {
  test('exposes signedCode usable as Lambda code', () => {
    const { signed } = buildConstruct();
    expect(signed.signedCode).toBeDefined();
  });

  test('artifacts bucket helper is versioned and KMS-encrypted', () => {
    const { template } = buildConstruct();
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' },
          }),
        ]),
      },
    });
  });

  test('emits a signing custom resource', () => {
    const { template } = buildConstruct();
    template.resourceCountIs('Custom::SignedLambdaArtifact', 1);
  });

  test('provider Lambda is NOT under a CodeSigningConfig', () => {
    const { template } = buildConstruct();
    // The construct must add zero CodeSigningConfig resources: the signing
    // provider is CDK-internal tooling and stays unsigned so the full template
    // keeps exactly three CSC resources (one per target function).
    template.resourceCountIs('AWS::Lambda::CodeSigningConfig', 0);

    // None of the Lambda functions created here reference a CodeSigningConfigArn.
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect((fn as any).Properties?.CodeSigningConfigArn).toBeUndefined();
    }
  });

  test('signing handler runs on a managed Node.js runtime', () => {
    const { template } = buildConstruct();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: Match.stringLikeRegexp('nodejs'),
      Handler: 'index.handler',
    });
  });
});
