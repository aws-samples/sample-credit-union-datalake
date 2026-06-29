// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Reusable deploy-time Lambda code-signing construct (Requirement R5, design D1).
//
// `SignedLambdaArtifact` performs hands-off AWS Signer signing during `cdk deploy`:
//   1. The asset (a directory or an already-built zip) is staged with `s3_assets.Asset`.
//   2. A Provider-backed custom resource copies the staged asset into a versioned,
//      KMS-encrypted artifacts bucket (AWS Signer requires a versioned source bucket),
//      calls `signer:StartSigningJob` against the supplied `SigningProfile`, polls
//      `signer:DescribeSigningJob` until the job reaches `Succeeded`, and returns the
//      signed object key + version.
//   3. The signed object is exposed as `signedCode` via
//      `lambda.Code.fromBucket(artifactsBucket, signedKey, signedVersion)`.
//
// The same flow is reused to sign the `pymysql` layer for the RDS loader, so the
// construct accepts any asset path (directory or zip).
//
// IMPORTANT (R5.4): the signing provider Lambda is intentionally NOT placed under a
// CodeSigningConfig — it is CDK-internal tooling. Keeping it un-signed leaves the
// synthesized template at exactly three `AWS::Lambda::CodeSigningConfig` resources
// (the three target functions) and avoids a chicken-and-egg signing loop.
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as signer from 'aws-cdk-lib/aws-signer';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface SignedLambdaArtifactProps {
  /**
   * Versioned, KMS-encrypted artifacts bucket used as both the AWS Signer source
   * (versioning is required) and the destination for the signed object.
   */
  readonly artifactsBucket: s3.IBucket;

  /**
   * The AWS Signer signing profile to sign the artifact with. The profile's
   * platform (e.g. AWS_LAMBDA_SHA384_ECDSA) determines the signing algorithm.
   */
  readonly signingProfile: signer.SigningProfile;

  /**
   * Path to the artifact to sign. May be a directory (zipped automatically) or a
   * pre-built zip file. Used for both Lambda function handlers and Lambda layers.
   */
  readonly assetPath: string;
}

/**
 * Options for the optional {@link SignedLambdaArtifact.createArtifactsBucket} helper.
 */
export interface ArtifactsBucketOptions {
  /** Explicit bucket name. Defaults to a CloudFormation-generated name. */
  readonly bucketName?: string;
  /** Optional server-access-logs bucket (satisfies AwsSolutions-S1). */
  readonly serverAccessLogsBucket?: s3.IBucket;
  /** Prefix for server access logs in {@link serverAccessLogsBucket}. */
  readonly serverAccessLogsPrefix?: string;
}

/**
 * The inline Node.js handler for the signing custom resource. Runs in the
 * managed Lambda runtime (AWS SDK v3 is available without bundling).
 */
const SIGNING_HANDLER = `
const { S3Client, CopyObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { SignerClient, StartSigningJobCommand, DescribeSigningJobCommand } = require('@aws-sdk/client-signer');

const s3 = new S3Client({});
const signerClient = new SignerClient({});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.handler = async (event) => {
  console.log('Signing custom resource event:', JSON.stringify(event));
  const requestType = event.RequestType;
  const props = event.ResourceProperties || {};

  // The signed/unsigned objects live in the artifacts bucket, which is emptied
  // when the stack is destroyed (autoDeleteObjects). Nothing to undo on Delete.
  if (requestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const {
    ArtifactsBucket,
    SourceBucket,
    SourceKey,
    ProfileName,
    ProfileVersion,
    UnsignedPrefix,
    SignedPrefix,
  } = props;

  // 1. Copy the staged (unsigned) asset into the versioned artifacts bucket so
  //    AWS Signer can read it from a versioned source.
  const fileName = SourceKey.split('/').pop();
  const unsignedKey = UnsignedPrefix + fileName;
  const copyResult = await s3.send(new CopyObjectCommand({
    Bucket: ArtifactsBucket,
    Key: unsignedKey,
    CopySource: '/' + SourceBucket + '/' + SourceKey,
  }));
  const sourceVersion = copyResult.VersionId;
  if (!sourceVersion) {
    throw new Error('Artifacts bucket must be versioned: CopyObject returned no VersionId');
  }

  // 2. Start the signing job against the supplied profile.
  const startParams = {
    source: { s3: { bucketName: ArtifactsBucket, key: unsignedKey, version: sourceVersion } },
    destination: { s3: { bucketName: ArtifactsBucket, prefix: SignedPrefix } },
    profileName: ProfileName,
  };
  if (ProfileVersion) {
    startParams.profileVersion = ProfileVersion;
  }
  const start = await signerClient.send(new StartSigningJobCommand(startParams));
  const jobId = start.jobId;
  console.log('Started signing job:', jobId);

  // 3. Poll DescribeSigningJob until the job reaches a terminal state.
  let signedObject;
  for (let attempt = 0; attempt < 30; attempt++) {
    const describe = await signerClient.send(new DescribeSigningJobCommand({ jobId }));
    const status = describe.status;
    console.log('Signing job ' + jobId + ' status: ' + status);
    if (status === 'Succeeded') {
      signedObject = describe.signedObject;
      break;
    }
    if (status === 'Failed') {
      throw new Error('Signing job ' + jobId + ' failed: ' + (describe.statusReason || 'unknown'));
    }
    await sleep(10000);
  }
  if (!signedObject || !signedObject.s3 || !signedObject.s3.key) {
    throw new Error('Signing job ' + jobId + ' did not produce a signed object in time');
  }

  const signedKey = signedObject.s3.key;

  // 4. Resolve the signed object's version id for Code.fromBucket pinning.
  const head = await s3.send(new HeadObjectCommand({ Bucket: ArtifactsBucket, Key: signedKey }));
  const signedVersion = head.VersionId || '';

  return {
    PhysicalResourceId: 'signed-' + jobId,
    Data: {
      JobId: jobId,
      SignedObjectKey: signedKey,
      SignedObjectVersion: signedVersion,
    },
  };
};
`;

export class SignedLambdaArtifact extends Construct {
  /**
   * Signed deployment package, ready to pass to a Lambda function or layer as
   * its `code`. Backed by `lambda.Code.fromBucket(artifactsBucket, key, version)`.
   */
  public readonly signedCode: lambda.Code;

  /**
   * Convenience factory for a versioned, KMS-encrypted artifacts bucket suitable
   * for use as {@link SignedLambdaArtifactProps.artifactsBucket}. AWS Signer
   * requires a versioned source bucket, so versioning is mandatory here.
   */
  public static createArtifactsBucket(
    scope: Construct,
    id: string,
    encryptionKey: kms.IKey,
    options: ArtifactsBucketOptions = {},
  ): s3.Bucket {
    return new s3.Bucket(scope, id, {
      bucketName: options.bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: options.serverAccessLogsBucket,
      serverAccessLogsPrefix: options.serverAccessLogsPrefix,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }

  constructor(scope: Construct, id: string, props: SignedLambdaArtifactProps) {
    super(scope, id);

    // Stage the unsigned asset. A directory is zipped automatically; a pre-built
    // zip is uploaded as-is. Either way we get a single object in the CDK staging
    // bucket that the signing handler copies into the versioned artifacts bucket.
    const asset = new s3assets.Asset(this, 'UnsignedAsset', {
      path: props.assetPath,
    });

    // onEvent handler for the signing custom resource. Intentionally carries NO
    // CodeSigningConfig — this is CDK-internal tooling (R5.4).
    const onEventFn = new lambda.Function(this, 'SigningOnEvent', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(SIGNING_HANDLER),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      description: 'Deploy-time AWS Signer signing for Lambda artifacts (CDK-internal tooling)',
    });

    // Read the staged unsigned asset (and its KMS key, if any).
    asset.grantRead(onEventFn);
    // Read/write (and KMS encrypt/decrypt) on the versioned artifacts bucket.
    props.artifactsBucket.grantReadWrite(onEventFn);
    // AWS Signer does not support resource-level permissions for these actions;
    // the broad resource is suppressed (AwsSolutions-IAM5) and recorded in task 5.1.
    onEventFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['signer:StartSigningJob', 'signer:DescribeSigningJob'],
      resources: ['*'],
    }));

    const provider = new cr.Provider(this, 'SigningProvider', {
      onEventHandler: onEventFn,
    });

    const signingResource = new cdk.CustomResource(this, 'SigningResource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::SignedLambdaArtifact',
      properties: {
        ArtifactsBucket: props.artifactsBucket.bucketName,
        SourceBucket: asset.s3BucketName,
        SourceKey: asset.s3ObjectKey,
        ProfileName: props.signingProfile.signingProfileName,
        ProfileVersion: props.signingProfile.signingProfileVersion,
        UnsignedPrefix: `unsigned/${id}/`,
        SignedPrefix: `signed/${id}/`,
        // Re-run signing whenever the source asset content changes.
        AssetHash: asset.assetHash,
      },
    });

    const signedKey = signingResource.getAttString('SignedObjectKey');
    const signedVersion = signingResource.getAttString('SignedObjectVersion');

    this.signedCode = lambda.Code.fromBucket(props.artifactsBucket, signedKey, signedVersion);

    // ========================================================================
    // cdk-nag suppressions — signing provider Lambda (CDK-internal tooling, R5.4)
    // See docs/security-exceptions.md (Exception 7). These suppressions are
    // scoped to this construct instance's own child nodes (the onEvent signing
    // function and the provider framework function) and are applied here so they
    // travel with every reuse of SignedLambdaArtifact, independent of the
    // consuming stack's name (test-portability per the design path convention).
    // ========================================================================
    NagSuppressions.addResourceSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is applied by CDK to the deploy-time signing onEvent function and the custom-resource provider framework function for CloudWatch logging. These are CDK-internal signing tooling (R5.4); the managed policy only grants log-group/log-stream/PutLogEvents. Exception 7 in docs/security-exceptions.md.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Deploy-time signing tooling (R5.4). The onEvent function policy contains: (1) grantRead/grantReadWrite wildcards on the staged-asset and versioned artifacts buckets (s3:GetObject*, s3:GetBucket*, s3:List*, s3:Abort*, s3:DeleteObject*, s3:PutObject*) and the corresponding KMS wildcards (kms:GenerateDataKey*, kms:ReEncrypt*) — these are object-level grants scoped to specific bucket/key ARNs created by the CDK grant helpers; and (2) signer:StartSigningJob / signer:DescribeSigningJob on Resource::* because AWS Signer does not support resource-level permissions for these actions. The provider framework function policy contains a lambda:InvokeFunction wildcard (<onEvent>.Arn:*) auto-generated by the cr.Provider construct. Exception 7 in docs/security-exceptions.md.'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'The custom-resource provider framework Lambda runtime is managed by the AWS CDK cr.Provider construct and updates with CDK library upgrades; it cannot be customized. Exception 7 in docs/security-exceptions.md.'
      }
    ], true);
  }
}
