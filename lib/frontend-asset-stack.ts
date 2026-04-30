// Frontend asset delivery: dedicated S3 bucket + CloudFront distribution for
// Vite-built hashed JS/CSS/font/image chunks. Hashed filenames are immutable,
// so when a deploy ships, old chunks must still be reachable for users whose
// cached index.html still points to them — otherwise they hit "Failed to fetch
// dynamically imported module". Chunks are kept for the FE_ASSET_LIFECYCLE_DAYS
// window, after which the lifecycle rule expires them.

import {
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

const FE_ASSET_LIFECYCLE_DAYS_DEFAULT = 365;

export class FrontendAssetStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const lifecycleDaysRaw = this.node.tryGetContext('FE_ASSET_LIFECYCLE_DAYS');
    const lifecycleDays =
      lifecycleDaysRaw === undefined ? FE_ASSET_LIFECYCLE_DAYS_DEFAULT : Number(lifecycleDaysRaw);
    if (!Number.isInteger(lifecycleDays) || lifecycleDays <= 0) {
      throw new Error(
        `FE_ASSET_LIFECYCLE_DAYS must be a positive integer, got: ${lifecycleDaysRaw}`
      );
    }

    // Per-account default keeps the bucket name globally unique without
    // hardcoding env labels. Override via -c FE_ASSET_BUCKET_NAME=… if needed.
    const bucketName: string =
      this.node.tryGetContext('FE_ASSET_BUCKET_NAME') || `curate-frontend-assets-${this.account}`;

    // RETAIN so a `cdk destroy` doesn't take the bucket — and every old chunk
    // with it — out from under live users. The lifecycle rule below handles
    // routine expiration.
    const feAssetBucket = new s3.Bucket(this, 'fe-asset-bucket', {
      bucketName,
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-old-frontend-chunks',
          // Must match the prefix the Curate upload script writes under
          // (currently `assets/`). Objects written outside this prefix are
          // never expired.
          prefix: 'assets/',
          expiration: Duration.days(lifecycleDays),
        },
      ],
    });

    // Grant the existing Heroku-side IAM user (BackendAccessKey, behind
    // AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) PutObject under assets/. This
    // lets the heroku-postbuild upload script use the SDK's default
    // credential chain — no separate FE_AWS_* env vars needed.
    feAssetBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBackendAccessKeyUploadFrontendChunks',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(`arn:aws:iam::${this.account}:user/BackendAccessKey`),
        ],
        actions: ['s3:PutObject'],
        resources: [feAssetBucket.arnForObjects('assets/*')],
      })
    );

    // The page is served from a different origin than the CDN, so module
    // imports and font fetches go through CORS. The S3 bucket has no CORS
    // config, so S3 itself doesn't emit CORS headers — this policy adds them
    // at the CloudFront layer. `originOverride: false` means S3 wins if it
    // ever starts emitting its own CORS headers.
    //
    // Allow-origin `*` is acceptable here: chunks are public, hashed,
    // immutable, and credential-less. We can't statically allowlist origins
    // because Curate serves customer-owned custom domains that change over
    // time. Credentials are explicitly disabled below to keep this safe.
    const corsResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'fe-asset-response-headers',
      {
        responseHeadersPolicyName: `FrontendAssetResponsePolicy${this.node.addr}`,
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET', 'HEAD'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },
      }
    );

    // CACHING_OPTIMIZED is the AWS-managed policy that caches by URL only.
    // Actual edge + browser TTL is governed by the `Cache-Control` header
    // the Curate upload script writes onto each object
    // (`public, max-age=31536000, immutable`).
    const distribution = new cloudfront.Distribution(this, 'fe-asset-distribution', {
      comment: 'frontend asset delivery - Vite-built hashed chunks',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.S3Origin(feAssetBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: corsResponseHeadersPolicy,
        compress: true,
      },
    });

    new CfnOutput(this, 'FrontendAssetBucket', {
      description: 'S3 bucket for Vite-built frontend chunks',
      value: feAssetBucket.bucketName,
    });
    new CfnOutput(this, 'FrontendAssetDistributionDomain', {
      description: 'CloudFront domain for frontend assets',
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, 'FrontendAssetDistributionId', {
      description: 'CloudFront distribution ID (use for invalidations)',
      value: distribution.distributionId,
    });
  }
}
