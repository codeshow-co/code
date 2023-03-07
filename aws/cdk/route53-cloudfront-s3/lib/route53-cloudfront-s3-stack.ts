// import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_rds as rds,
  aws_ssm as ssm,
  CfnOutput, Duration, RemovalPolicy,
  Stack,
  StackProps
} from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import {Construct} from "constructs";
import * as dotenv from 'dotenv' 

dotenv.config()

export class Route53CloudfrontS3Stack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const domain: string = process.env.HOSTED_ZONE_NAME!
    const subdomain: string = process.env.SUBDOMAIN!

    const zone = route53.HostedZone.fromLookup(this, domain, {
      domainName: domain
    })

    const cdnDomain = `${subdomain}.${domain}`
    const cdnCloudfrontOAI = new cloudfront.OriginAccessIdentity(this, 'cdn-cloudfront-OAI', {
      comment: `OAI for ${id}`
    });

    // cloudfront's certification-manager must in us-east-1
    const cdnCertificate = new acm.DnsValidatedCertificate(this, 'CdnSiteCertificate', {
      domainName: cdnDomain,
      hostedZone: zone,
      region: 'us-east-1',
    });
    new CfnOutput(this, 'CdnCertificate', { value: cdnCertificate.certificateArn });
    new CfnOutput(this, 'CdnSite', { value: 'https://' + cdnDomain });

    // s3 cdn
    const cdnBucket = new s3.Bucket(this, 'CdnBucket', {
      bucketName: cdnDomain,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // removalPolicy: RemovalPolicy.DESTROY, // NOT recommended for production code
      // autoDeleteObjects: true, // NOT recommended for production code
    });

    cdnBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [cdnBucket.arnForObjects('*')],
      principals: [new iam.CanonicalUserPrincipal(cdnCloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId)]
    }));
    new CfnOutput(this, 'CdnBucketOutput', { value: cdnBucket.bucketName });


    const cdnDistribution = new cloudfront.Distribution(this, 'CdnDistribution', {
      certificate: cdnCertificate,
      defaultRootObject: "index.html",
      domainNames: [cdnDomain],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      errorResponses:[
        {
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: '/403.html',
          ttl: Duration.minutes(30),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(30),
        }
      ],
      defaultBehavior: {
        origin: new cloudfront_origins.S3Origin(cdnBucket, {originAccessIdentity: cdnCloudfrontOAI}),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      }
    })

    new CfnOutput(this, 'CdnDistributionId', { value: cdnDistribution.distributionId });

    // Route53 alias record for the CloudFront distribution
    new route53.ARecord(this, 'CdnAliasRecord', {
      recordName: cdnDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(cdnDistribution)),
      zone
    });

    // Deploy site contents to S3 bucket
    new s3deploy.BucketDeployment(this, 'CdnDeployWithInvalidation', {
      sources: [s3deploy.Source.asset("./html")],
      destinationBucket: cdnBucket,
      distribution: cdnDistribution,
      distributionPaths: ['/*'],
    });
  }
}
