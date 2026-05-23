# Victor Portfolio

Personal portfolio website for Victor Yeung, focused on art and photography.

## Current State

The M1 foundation is live at:

- https://victor-yeung.com

The site is served by CloudFront over HTTPS from a private S3 bucket.

## Target Architecture

The production version will move to:

- Astro frontend
- AWS CDK in TypeScript for infrastructure
- Private S3 buckets behind CloudFront Origin Access Control
- ACM certificate for HTTPS
- Route 53 DNS
- Lambda-based image pipeline
- Admin UI for uploads, metadata, watermark settings, and soft-delete

## M1 Foundation

The M1 implementation lives in:

- `site/` - Astro coming-soon site
- `infra/` - AWS CDK foundation stack

M1 intentionally does not include GitHub Actions yet. Deploy manually with:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-m1.ps1
```

M1 sets up:

- HTTPS via CloudFront + ACM
- private S3 site bucket
- private S3 photos bucket
- CloudFront Origin Access Control
- `victor-yeung.com` as the canonical apex domain
- `www.victor-yeung.com` redirecting to the apex domain

## Analytics

Google Analytics is opt-in via `PUBLIC_GA_ID`.

Create `site/.env` on the deploy machine to enable it:

```text
PUBLIC_GA_ID=G-8EK1C2QSY7
```

Leave `PUBLIC_GA_ID` unset to build without Google Analytics. The layout also skips analytics on future `/admin/*` routes. A cookie-consent banner is intentionally deferred until traffic/privacy requirements justify it.

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
cd infra
npx cdk destroy --all
```

## Launch Decisions

- `www.victor-yeung.com` redirects to `victor-yeung.com`
- Full-size watermarked images are downloadable
- Launch with a single curated gallery
- Admin delete starts as soft-delete
- Full admin system ships before public launch

## Previous Temporary Site

The earlier HTTP-only S3 website bucket was replaced by M1 DNS records pointing to CloudFront. The temporary deployment files were removed from this branch to avoid accidentally restoring the old HTTP-only path.
