# Infrastructure

M1 foundation for `victor-yeung.com`.

This milestone uses AWS CDK for the foundation and a manual PowerShell deploy script for deployment orchestration. GitHub Actions are intentionally not included yet.

## What It Creates

- Private S3 bucket for the Astro site: `victor-yeung-site`
- Private S3 bucket for photos and metadata: `victor-yeung-photos`
- CloudFront distribution with Origin Access Control
- ACM certificate in `us-east-1`
- Route 53 aliases for apex and `www`
- `www.victor-yeung.com` redirects to `victor-yeung.com`

## Deploy

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-m1.ps1
```

The script expects:

- AWS CLI v2 configured with the `default` profile
- Node.js 22+ with npm available
- Existing Route 53 hosted zone `victor-yeung.com`

On this machine, the script also detects the local portable Node/npm under `tools/`.

## Rollback

For a broken site content deploy, restore a previous S3 object version and invalidate CloudFront:

```powershell
aws s3api list-object-versions --bucket victor-yeung-site --prefix index.html

aws s3api copy-object --bucket victor-yeung-site --key index.html `
  --copy-source "victor-yeung-site/index.html?versionId=<VERSION_ID>"

aws cloudfront create-invalidation --distribution-id <DISTRIBUTION_ID> --paths "/*"
```

For infrastructure deploy failures, CloudFormation automatically rolls back failed stack updates. For a successful but incorrect infrastructure change, revert the commit and rerun:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-m1.ps1
```

For a structural change that needs CloudFormation rollback:

```powershell
aws cloudformation rollback-stack --stack-name VictorPortfolioFoundationStack --region us-west-2
```

For a last-resort full teardown, remember the S3 buckets use `RETAIN`. Empty and remove retained buckets manually, then destroy the stacks:

```powershell
aws s3 rm s3://victor-yeung-site --recursive
aws s3 rm s3://victor-yeung-photos --recursive
aws s3 rb s3://victor-yeung-site
aws s3 rb s3://victor-yeung-photos
npx cdk destroy --all
```
