import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface VictorPortfolioFoundationStackProps extends StackProps {
  certificate: acm.ICertificate;
}

const DOMAIN_NAME = 'victor-yeung.com';
const WWW_DOMAIN_NAME = `www.${DOMAIN_NAME}`;
const CLOUDFRONT_HOSTED_ZONE_ID = 'Z2FDTNDATAQYW2';
const HOSTED_ZONE_ID = 'Z0659489BL36QJD9CF0F';
const CACHE_POLICY_CACHING_DISABLED_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ORIGIN_REQUEST_POLICY_ALL_VIEWER_EXCEPT_HOST_ID = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
const currentDir = dirname(fileURLToPath(import.meta.url));
const infraRoot = join(currentDir, '..');

export class VictorPortfolioFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: VictorPortfolioFoundationStackProps) {
    super(scope, id, props);

    const adminUsername = requireAdminEnv('ADMIN_USERNAME');
    const adminPassword = requireAdminEnv('ADMIN_PASSWORD');
    const adminBasicAuthHeader = `Basic ${Buffer.from(`${adminUsername}:${adminPassword}`).toString('base64')}`;
    const adminOriginSecret = createHash('sha256')
      .update(`${DOMAIN_NAME}:${adminBasicAuthHeader}`)
      .digest('hex');

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: 'victor-yeung-site',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const photosBucket = new s3.Bucket(this, 'PhotosBucket', {
      bucketName: 'victor-yeung-photos',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [`https://${DOMAIN_NAME}`],
          exposedHeaders: ['ETag'],
          maxAge: 300
        }
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const redirectWwwFunction = new cloudfront.Function(this, 'RedirectWwwFunction', {
      code: cloudfront.FunctionCode.fromInline(`
function queryString(request) {
  var query = '';
  var querystring = request.querystring || {};
  var keys = Object.keys(querystring);

  if (keys.length > 0) {
    query = '?' + keys.map(function(key) {
      var item = querystring[key];
      if (item.multiValue) {
        return item.multiValue.map(function(value) {
          return key + '=' + value.value;
        }).join('&');
      }
      return key + '=' + item.value;
    }).join('&');
  }

  return query;
}

function redirectToApex(request) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: 'https://${DOMAIN_NAME}' + request.uri + queryString(request) },
      'cache-control': { value: 'max-age=3600' }
    }
  };
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;

  if (host === '${WWW_DOMAIN_NAME}') {
    return redirectToApex(request);
  }

  return request;
}
`)
    });

    const rewritePhotosFunction = new cloudfront.Function(this, 'RewritePhotosFunction', {
      code: cloudfront.FunctionCode.fromInline(`
function queryString(request) {
  var query = '';
  var querystring = request.querystring || {};
  var keys = Object.keys(querystring);

  if (keys.length > 0) {
    query = '?' + keys.map(function(key) {
      var item = querystring[key];
      if (item.multiValue) {
        return item.multiValue.map(function(value) {
          return key + '=' + value.value;
        }).join('&');
      }
      return key + '=' + item.value;
    }).join('&');
  }

  return query;
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;

  if (host === '${WWW_DOMAIN_NAME}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://${DOMAIN_NAME}' + request.uri + queryString(request) },
        'cache-control': { value: 'max-age=3600' }
      }
    };
  }

  if (request.uri.indexOf('/photos/') === 0) {
    request.uri = request.uri.slice('/photos'.length);
  }

  return request;
}
`)
    });

    const adminBasicAuthFunction = new cloudfront.Function(this, 'AdminBasicAuthFunction', {
      code: cloudfront.FunctionCode.fromInline(`
function queryString(request) {
  var query = '';
  var querystring = request.querystring || {};
  var keys = Object.keys(querystring);

  if (keys.length > 0) {
    query = '?' + keys.map(function(key) {
      var item = querystring[key];
      if (item.multiValue) {
        return item.multiValue.map(function(value) {
          return key + '=' + value.value;
        }).join('&');
      }
      return key + '=' + item.value;
    }).join('&');
  }

  return query;
}

function redirectToApex(request) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: 'https://${DOMAIN_NAME}' + request.uri + queryString(request) },
      'cache-control': { value: 'max-age=3600' }
    }
  };
}

function isAdminRequest(uri) {
  return uri === '/admin' || uri.indexOf('/admin/') === 0 || uri === '/api/admin' || uri.indexOf('/api/admin/') === 0;
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;

  if (host === '${WWW_DOMAIN_NAME}') {
    return redirectToApex(request);
  }

  if (isAdminRequest(request.uri)) {
    var auth = request.headers.authorization && request.headers.authorization.value;
    if (auth !== ${JSON.stringify(adminBasicAuthHeader)}) {
      return {
        statusCode: 401,
        statusDescription: 'Unauthorized',
        headers: {
          'cache-control': { value: 'no-store' },
          'www-authenticate': { value: 'Basic realm="Victor Admin"' }
        }
      };
    }
  }

  if (request.uri === '/admin' || request.uri === '/admin/') {
    request.uri = '/admin/index.html';
  }

  return request;
}
`)
    });

    const originAccessControl = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        name: 'victor-portfolio-s3-oac',
        description: 'CloudFront access to private Victor Portfolio S3 buckets.',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4'
      }
    });

    const staticCachePolicy = new cloudfront.CfnCachePolicy(this, 'StaticCachePolicy', {
      cachePolicyConfig: {
        name: 'victor-portfolio-static-cache',
        comment: 'Short static cache while the portfolio is under active build.',
        defaultTtl: Duration.minutes(5).toSeconds(),
        maxTtl: Duration.days(1).toSeconds(),
        minTtl: 0,
        parametersInCacheKeyAndForwardedToOrigin: {
          cookiesConfig: { cookieBehavior: 'none' },
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
          headersConfig: { headerBehavior: 'none' },
          queryStringsConfig: { queryStringBehavior: 'none' }
        }
      }
    });

    const dataCachePolicy = new cloudfront.CfnCachePolicy(this, 'DataCachePolicy', {
      cachePolicyConfig: {
        name: 'victor-portfolio-data-cache',
        comment: 'Low TTL for JSON metadata used by the gallery/admin pipeline.',
        defaultTtl: Duration.seconds(60).toSeconds(),
        maxTtl: Duration.minutes(5).toSeconds(),
        minTtl: 0,
        parametersInCacheKeyAndForwardedToOrigin: {
          cookiesConfig: { cookieBehavior: 'none' },
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
          headersConfig: { headerBehavior: 'none' },
          queryStringsConfig: { queryStringBehavior: 'none' }
        }
      }
    });

    const imageReprocessDlq = new sqs.Queue(this, 'ImageReprocessDlq', {
      queueName: 'image-reprocess-dlq',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14)
    });

    const imageReprocessQueue = new sqs.Queue(this, 'ImageReprocessQueue', {
      queueName: 'image-reprocess-queue',
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: imageReprocessDlq
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(90)
    });

    new cloudwatch.Alarm(this, 'ImageReprocessDlqDepthAlarm', {
      alarmDescription: 'Image reprocess messages have moved to the dead-letter queue.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      metric: imageReprocessDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1)
      }),
      threshold: 1
    });

    const sharpLayer = new lambda.LayerVersion(this, 'SharpLayer', {
      code: lambda.Code.fromAsset(join(infraRoot, 'layers', 'sharp')),
      compatibleArchitectures: [lambda.Architecture.X86_64],
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: 'Sharp image processing dependency for Victor Portfolio.'
    });

    const imageProcessor = new NodejsFunction(this, 'ImageProcessor', {
      architecture: lambda.Architecture.X86_64,
      bundling: {
        externalModules: ['sharp'],
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        target: 'node22'
      },
      entry: join(infraRoot, 'lambda', 'image-processor', 'index.ts'),
      environment: {
        PHOTOS_BUCKET: photosBucket.bucketName
      },
      layers: [sharpLayer],
      memorySize: 3008,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30)
    });

    photosBucket.grantReadWrite(imageProcessor);
    imageReprocessQueue.grantConsumeMessages(imageProcessor);
    imageProcessor.addEventSource(new SqsEventSource(imageReprocessQueue, { batchSize: 1 }));
    photosBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(imageProcessor),
      { prefix: 'originals/' }
    );
    photosBucket.addEventNotification(
      s3.EventType.OBJECT_REMOVED,
      new s3n.LambdaDestination(imageProcessor),
      { prefix: 'originals/' }
    );

    const republishTrigger = new NodejsFunction(this, 'RepublishTrigger', {
      architecture: lambda.Architecture.X86_64,
      bundling: {
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        target: 'node22'
      },
      entry: join(infraRoot, 'lambda', 'republish-trigger', 'index.ts'),
      environment: {
        PHOTOS_BUCKET: photosBucket.bucketName,
        QUEUE_URL: imageReprocessQueue.queueUrl
      },
      memorySize: 256,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60)
    });

    imageReprocessQueue.grantSendMessages(republishTrigger);
    republishTrigger.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        conditions: {
          StringLike: {
            's3:prefix': ['originals/', 'originals/*']
          }
        },
        resources: [photosBucket.bucketArn]
      })
    );

    const adminApi = new NodejsFunction(this, 'AdminApi', {
      architecture: lambda.Architecture.X86_64,
      bundling: {
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        target: 'node22'
      },
      entry: join(infraRoot, 'lambda', 'admin-api', 'index.ts'),
      environment: {
        ADMIN_ORIGIN_SECRET: adminOriginSecret,
        DOMAIN_NAME,
        PHOTOS_BUCKET: photosBucket.bucketName,
        REPUBLISH_FUNCTION_NAME: republishTrigger.functionName,
        REPROCESS_QUEUE_URL: imageReprocessQueue.queueUrl
      },
      memorySize: 512,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30)
    });

    photosBucket.grantReadWrite(adminApi);
    republishTrigger.grantInvoke(adminApi);
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:GetQueueAttributes'],
        resources: [imageReprocessQueue.queueArn]
      })
    );
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:ListDistributions'],
        resources: ['*']
      })
    );

    const adminHttpApi = new apigwv2.HttpApi(this, 'AdminHttpApi', {
      apiName: 'victor-portfolio-admin-api',
      createDefaultStage: true
    });
    const adminHttpIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      'AdminHttpIntegration',
      adminApi
    );

    adminHttpApi.addRoutes({
      path: '/api/admin',
      methods: [apigwv2.HttpMethod.ANY],
      integration: adminHttpIntegration
    });
    adminHttpApi.addRoutes({
      path: '/api/admin/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: adminHttpIntegration
    });

    const apiOriginDomain = cdk.Fn.join('', [
      adminHttpApi.apiId,
      '.execute-api.',
      cdk.Aws.REGION,
      '.',
      cdk.Aws.URL_SUFFIX
    ]);

    const apiCacheBehavior = {
      allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
      cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
      cachePolicyId: CACHE_POLICY_CACHING_DISABLED_ID,
      compress: true,
      functionAssociations: [
        {
          eventType: 'viewer-request',
          functionArn: adminBasicAuthFunction.functionArn
        }
      ],
      originRequestPolicyId: ORIGIN_REQUEST_POLICY_ALL_VIEWER_EXCEPT_HOST_ID,
      targetOriginId: 'admin-api-origin',
      viewerProtocolPolicy: 'redirect-to-https'
    };

    const distribution = new cloudfront.CfnDistribution(this, 'Distribution', {
      distributionConfig: {
        aliases: [DOMAIN_NAME, WWW_DOMAIN_NAME],
        comment: 'Victor Yeung portfolio',
        customErrorResponses: [
          {
            errorCode: 403,
            errorCachingMinTtl: 60,
            responseCode: 404,
            responsePagePath: '/404.html'
          },
          {
            errorCode: 404,
            errorCachingMinTtl: 60,
            responseCode: 404,
            responsePagePath: '/404.html'
          }
        ],
        defaultCacheBehavior: {
          allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
          cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
          cachePolicyId: staticCachePolicy.ref,
          compress: true,
          functionAssociations: [
            {
              eventType: 'viewer-request',
              functionArn: redirectWwwFunction.functionArn
            }
          ],
          targetOriginId: 'site-origin',
          viewerProtocolPolicy: 'redirect-to-https'
        },
        defaultRootObject: 'index.html',
        enabled: true,
        httpVersion: 'http2and3',
        ipv6Enabled: true,
        origins: [
          {
            domainName: siteBucket.bucketRegionalDomainName,
            id: 'site-origin',
            originAccessControlId: originAccessControl.attrId,
            s3OriginConfig: { originAccessIdentity: '' }
          },
          {
            domainName: photosBucket.bucketRegionalDomainName,
            id: 'photos-origin',
            originAccessControlId: originAccessControl.attrId,
            s3OriginConfig: { originAccessIdentity: '' }
          },
          {
            customOriginConfig: {
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1.2']
            },
            domainName: apiOriginDomain,
            id: 'admin-api-origin',
            originCustomHeaders: [
              {
                headerName: 'x-admin-origin-secret',
                headerValue: adminOriginSecret
              }
            ]
          }
        ],
        priceClass: 'PriceClass_100',
        viewerCertificate: {
          acmCertificateArn: props.certificate.certificateArn,
          minimumProtocolVersion: 'TLSv1.2_2021',
          sslSupportMethod: 'sni-only'
        },
        cacheBehaviors: [
          {
            pathPattern: '/api/admin',
            ...apiCacheBehavior
          },
          {
            pathPattern: '/api/admin/*',
            ...apiCacheBehavior
          },
          {
            pathPattern: '/admin*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: staticCachePolicy.ref,
            compress: true,
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: adminBasicAuthFunction.functionArn
              }
            ],
            targetOriginId: 'site-origin',
            viewerProtocolPolicy: 'redirect-to-https'
          },
          {
            pathPattern: '/photos/*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: staticCachePolicy.ref,
            compress: true,
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: rewritePhotosFunction.functionArn
              }
            ],
            targetOriginId: 'photos-origin',
            viewerProtocolPolicy: 'redirect-to-https'
          },
          {
            pathPattern: '/data/*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: dataCachePolicy.ref,
            compress: true,
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: redirectWwwFunction.functionArn
              }
            ],
            targetOriginId: 'photos-origin',
            viewerProtocolPolicy: 'redirect-to-https'
          }
        ]
      }
    });

    const distributionArn = cdk.Fn.join('', [
      'arn:',
      cdk.Aws.PARTITION,
      ':cloudfront::',
      cdk.Aws.ACCOUNT_ID,
      ':distribution/',
      distribution.ref
    ]);

    for (const bucket of [siteBucket, photosBucket]) {
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          conditions: {
            StringEquals: {
              'AWS:SourceArn': distributionArn
            }
          },
          principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
          resources: [bucket.arnForObjects('*')]
        })
      );
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN_NAME
    });

    const distributionAliasTarget: route53.IAliasRecordTarget = {
      bind: () => ({
        dnsName: distribution.attrDomainName,
        hostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID
      })
    };

    new route53.ARecord(this, 'ApexARecord', {
      zone,
      target: route53.RecordTarget.fromAlias(distributionAliasTarget)
    });

    new route53.AaaaRecord(this, 'ApexAaaaRecord', {
      zone,
      target: route53.RecordTarget.fromAlias(distributionAliasTarget)
    });

    new route53.ARecord(this, 'WwwARecord', {
      zone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(distributionAliasTarget)
    });

    new route53.AaaaRecord(this, 'WwwAaaaRecord', {
      zone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(distributionAliasTarget)
    });

    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'PhotosBucketName', { value: photosBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.ref });
    new CfnOutput(this, 'DistributionDomainName', { value: distribution.attrDomainName });
    new CfnOutput(this, 'CloudFrontHostedZoneId', { value: CLOUDFRONT_HOSTED_ZONE_ID });
    new CfnOutput(this, 'ImageProcessorFunctionName', { value: imageProcessor.functionName });
    new CfnOutput(this, 'RepublishTriggerFunctionName', { value: republishTrigger.functionName });
    new CfnOutput(this, 'ImageReprocessQueueUrl', { value: imageReprocessQueue.queueUrl });
    new CfnOutput(this, 'AdminHttpApiUrl', { value: adminHttpApi.apiEndpoint });
  }
}

function requireAdminEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before CDK synth/deploy. See infra/.env.example.`);
  }

  return value;
}
