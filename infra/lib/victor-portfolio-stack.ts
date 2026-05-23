import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface VictorPortfolioFoundationStackProps extends StackProps {
  certificate: acm.ICertificate;
}

const DOMAIN_NAME = 'victor-yeung.com';
const WWW_DOMAIN_NAME = `www.${DOMAIN_NAME}`;
const CLOUDFRONT_HOSTED_ZONE_ID = 'Z2FDTNDATAQYW2';
const HOSTED_ZONE_ID = 'Z0659489BL36QJD9CF0F';

export class VictorPortfolioFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: VictorPortfolioFoundationStackProps) {
    super(scope, id, props);

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
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const redirectWwwFunction = new cloudfront.Function(this, 'RedirectWwwFunction', {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;

  if (host === '${WWW_DOMAIN_NAME}') {
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

    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://${DOMAIN_NAME}' + request.uri + query },
        'cache-control': { value: 'max-age=3600' }
      }
    };
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
            pathPattern: '/photos/*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: staticCachePolicy.ref,
            compress: true,
            targetOriginId: 'photos-origin',
            viewerProtocolPolicy: 'redirect-to-https'
          },
          {
            pathPattern: '/data/*',
            allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            cachePolicyId: dataCachePolicy.ref,
            compress: true,
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
  }
}
