import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface VictorPortfolioFoundationStackProps extends StackProps {
  certificate: acm.ICertificate;
}

const DOMAIN_NAME = 'victor-yeung.com';
const WWW_DOMAIN_NAME = `www.${DOMAIN_NAME}`;
const CLOUDFRONT_HOSTED_ZONE_ID = 'Z2FDTNDATAQYW2';
const HOSTED_ZONE_ID = 'Z0659489BL36QJD9CF0F';
const ORIGIN_REQUEST_POLICY_ALL_VIEWER_EXCEPT_HOST_ID = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
const currentDir = dirname(fileURLToPath(import.meta.url));
const infraRoot = join(currentDir, '..');
const repoRoot = join(infraRoot, '..');

export class VictorPortfolioFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: VictorPortfolioFoundationStackProps) {
    super(scope, id, props);

    const adminUsername = requireAdminEnv('ADMIN_USERNAME');
    const adminPassword = requireAdminEnv('ADMIN_PASSWORD');
    const adminBasicAuthHeader = `Basic ${Buffer.from(`${adminUsername}:${adminPassword}`).toString('base64')}`;
    const adminOriginSecret = createHash('sha256')
      .update(`${DOMAIN_NAME}:${adminBasicAuthHeader}`)
      .digest('hex');
    const contactToEmail = requireAdminEnv('CONTACT_TO_EMAIL');
    const contactFromEmail = requireAdminEnv('CONTACT_FROM_EMAIL');
    const adminAlertEmail = requireAdminEnv('ADMIN_ALERT_EMAIL');
    const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY ?? '';

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN_NAME
    });

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

  if (request.uri === '/') {
    request.uri = '/index.html';
  } else if (request.uri.indexOf('/api/') !== 0 && request.uri.indexOf('.') === -1) {
    if (request.uri.slice(-1) === '/') {
      request.uri = request.uri + 'index.html';
    } else {
      request.uri = request.uri + '/index.html';
    }
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

    const publicDataFunction = new cloudfront.Function(this, 'PublicDataFunction', {
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

  if (request.uri !== '/data/gallery.json' && request.uri !== '/data/site.json') {
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: {
        'cache-control': { value: 'no-store' }
      }
    };
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

    const staticCachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
      cachePolicyName: 'victor-portfolio-static-cache',
      comment: 'Short static cache while the portfolio is under active build.',
      defaultTtl: Duration.minutes(5),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      maxTtl: Duration.days(1),
      minTtl: Duration.seconds(0)
    });
    (staticCachePolicy.node.defaultChild as cloudfront.CfnCachePolicy).overrideLogicalId('StaticCachePolicy');

    const dataCachePolicy = new cloudfront.CachePolicy(this, 'DataCachePolicy', {
      cachePolicyName: 'victor-portfolio-data-cache',
      comment: 'Low TTL for JSON metadata used by the gallery/admin pipeline.',
      defaultTtl: Duration.seconds(60),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      maxTtl: Duration.minutes(5),
      minTtl: Duration.seconds(0)
    });
    (dataCachePolicy.node.defaultChild as cloudfront.CfnCachePolicy).overrideLogicalId('DataCachePolicy');

    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      responseHeadersPolicyName: 'victor-portfolio-security-headers',
      comment: 'Security headers for Victor Yeung portfolio responses.',
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            override: true,
            value: 'camera=(), microphone=(), geolocation=()'
          }
        ]
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true
        }
      }
    });
    (securityHeadersPolicy.node.defaultChild as cloudfront.CfnResponseHeadersPolicy).overrideLogicalId('SecurityHeadersPolicy');

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

    const alertTopic = new sns.Topic(this, 'AdminAlertTopic', {
      displayName: 'Victor Portfolio alerts',
      topicName: 'victor-portfolio-alerts'
    });
    alertTopic.addSubscription(new subscriptions.EmailSubscription(adminAlertEmail));

    const imageReprocessDlqAlarm = new cloudwatch.Alarm(this, 'ImageReprocessDlqDepthAlarm', {
      alarmDescription: 'Image reprocess messages have moved to the dead-letter queue.',
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      metric: imageReprocessDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1)
      }),
      threshold: 1
    });
    imageReprocessDlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    const sharpSourceDir = join(infraRoot, 'layers', 'sharp');
    const sharpLayer = new lambda.LayerVersion(this, 'SharpLayer', {
      code: lambda.Code.fromAsset(sharpSourceDir, {
        bundling: {
          command: [
            'bash',
            '-c',
            'cd nodejs && npm install --omit=dev --os=linux --cpu=x64 --libc=glibc && cd .. && cp -r nodejs /asset-output/'
          ],
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const nodejsSource = join(sharpSourceDir, 'nodejs');
                const nodejsDest = join(outputDir, 'nodejs');
                execSync(`${shellQuote(resolveNpmCommand())} install --omit=dev --os=linux --cpu=x64 --libc=glibc`, {
                  cwd: nodejsSource,
                  stdio: 'inherit'
                });
                rmSync(nodejsDest, { force: true, recursive: true });
                cpSync(nodejsSource, nodejsDest, { recursive: true });
                return true;
              } catch {
                return false;
              }
            }
          },
          platform: 'linux/amd64'
        }
      }),
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
      logRetention: logs.RetentionDays.ONE_MONTH,
      memorySize: 1536,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30)
    });

    photosBucket.grantReadWrite(imageProcessor);
    imageReprocessQueue.grantConsumeMessages(imageProcessor);
    imageProcessor.addEventSource(new SqsEventSource(imageReprocessQueue, { batchSize: 1 }));
    photosBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
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
      logRetention: logs.RetentionDays.ONE_MONTH,
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
      logRetention: logs.RetentionDays.ONE_MONTH,
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
    new ses.EmailIdentity(this, 'SiteEmailIdentity', {
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      dkimSigning: true,
      identity: ses.Identity.publicHostedZone(zone),
      mailFromDomain: `mail.${DOMAIN_NAME}`
    });

    new route53.TxtRecord(this, 'DmarcRecord', {
      recordName: '_dmarc',
      ttl: Duration.minutes(5),
      values: [`v=DMARC1; p=none; rua=mailto:${adminAlertEmail}`],
      zone
    });

    new ses.CfnEmailIdentity(this, 'ContactFromEmailIdentity', {
      emailIdentity: contactToEmail
    });

    const contactApi = new NodejsFunction(this, 'ContactApi', {
      architecture: lambda.Architecture.X86_64,
      bundling: {
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        target: 'node22'
      },
      entry: join(infraRoot, 'lambda', 'contact-api', 'index.ts'),
      environment: {
        ADMIN_ORIGIN_SECRET: adminOriginSecret,
        CONTACT_FROM_EMAIL: contactFromEmail,
        CONTACT_TO_EMAIL: contactToEmail,
        DOMAIN_NAME,
        TURNSTILE_SECRET_KEY: turnstileSecretKey
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      memorySize: 256,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(15)
    });

    contactApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
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
    const contactHttpIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      'ContactHttpIntegration',
      contactApi
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
    adminHttpApi.addRoutes({
      path: '/api/contact',
      methods: [apigwv2.HttpMethod.ANY],
      integration: contactHttpIntegration
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
      cachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
      compress: true,
      functionAssociations: [
        {
          eventType: 'viewer-request',
          functionArn: adminBasicAuthFunction.functionArn
        }
      ],
      originRequestPolicyId: ORIGIN_REQUEST_POLICY_ALL_VIEWER_EXCEPT_HOST_ID,
      responseHeadersPolicyId: securityHeadersPolicy.responseHeadersPolicyId,
      targetOriginId: 'admin-api-origin',
      viewerProtocolPolicy: 'redirect-to-https'
    };

    const contactApiCacheBehavior = {
      allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
      cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
      cachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
      compress: true,
      functionAssociations: [
        {
          eventType: 'viewer-request',
          functionArn: redirectWwwFunction.functionArn
        }
      ],
      originRequestPolicyId: ORIGIN_REQUEST_POLICY_ALL_VIEWER_EXCEPT_HOST_ID,
      responseHeadersPolicyId: securityHeadersPolicy.responseHeadersPolicyId,
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
          cachePolicyId: staticCachePolicy.cachePolicyId,
          compress: true,
          functionAssociations: [
            {
              eventType: 'viewer-request',
              functionArn: redirectWwwFunction.functionArn
            }
          ],
          responseHeadersPolicyId: securityHeadersPolicy.responseHeadersPolicyId,
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
            pathPattern: '/api/contact',
            ...contactApiCacheBehavior
          },
          {
            pathPattern: '/admin*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: staticCachePolicy.cachePolicyId,
            compress: true,
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: adminBasicAuthFunction.functionArn
              }
            ],
            responseHeadersPolicyId: securityHeadersPolicy.responseHeadersPolicyId,
            targetOriginId: 'site-origin',
            viewerProtocolPolicy: 'redirect-to-https'
          },
          {
            pathPattern: '/photos/*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: staticCachePolicy.cachePolicyId,
            compress: true,
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: rewritePhotosFunction.functionArn
              }
            ],
            responseHeadersPolicyId: securityHeadersPolicy.responseHeadersPolicyId,
            targetOriginId: 'photos-origin',
            viewerProtocolPolicy: 'redirect-to-https'
          },
          {
            pathPattern: '/data/*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: dataCachePolicy.cachePolicyId,
            compress: true,
            functionAssociations: [
              {
                eventType: 'viewer-request',
                functionArn: publicDataFunction.functionArn
              }
            ],
            responseHeadersPolicyId: securityHeadersPolicy.responseHeadersPolicyId,
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

    adminApi.addEnvironment('DISTRIBUTION_ID', distribution.ref);
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [distributionArn]
      })
    );

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
    new CfnOutput(this, 'ContactApiFunctionName', { value: contactApi.functionName });
    new CfnOutput(this, 'ImageReprocessQueueUrl', { value: imageReprocessQueue.queueUrl });
    new CfnOutput(this, 'AdminHttpApiUrl', { value: adminHttpApi.apiEndpoint });
    new CfnOutput(this, 'ContactToEmail', { value: contactToEmail });
    new CfnOutput(this, 'ContactFromEmail', { value: contactFromEmail });
    new CfnOutput(this, 'AdminAlertEmail', { value: adminAlertEmail });
  }
}

function requireAdminEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before CDK synth/deploy. See infra/.env.example.`);
  }

  return value;
}

function resolveNpmCommand(): string {
  if (process.env.NPM_PATH && existsSync(process.env.NPM_PATH)) {
    return process.env.NPM_PATH;
  }

  const localNpm = join(repoRoot, 'tools', 'node', 'node-v24.14.0-win-x64', process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (existsSync(localNpm)) {
    return localNpm;
  }

  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}
