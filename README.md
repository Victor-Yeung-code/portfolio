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

## M2 Image Pipeline

Upload originals to:

```text
s3://victor-yeung-photos/originals/{id}.{jpg|jpeg|png|webp|tif|tiff|avif}
```

The image processor Lambda generates:

- `thumb/{id}.webp` at 400px wide
- `medium/{id}.webp` at 1200px wide
- `full/{id}.{ext}` as the original uploaded image for full-size downloads
- `data/photos.json` with gallery metadata

Deleting an object from `originals/` removes the generated assets and removes that photo from `data/photos.json`. Public image URLs use `/photos/...`; CloudFront rewrites that prefix to the private photos bucket keys.

## M3 Watermark Pipeline

Watermarking is controlled by `s3://victor-yeung-photos/data/watermark.json` and a PNG under `s3://victor-yeung-photos/watermarks/`.

Example config:

```json
{
  "file": "watermarks/current.png",
  "position": "bottom-right",
  "marginPct": 3,
  "widthPct": 15,
  "opacity": 0.7,
  "minWidthPx": 40,
  "maxWidthPx": 600
}
```

When a watermark is configured, the processor applies it after resizing each variant. `thumb` and `medium` remain WebP. `full/{id}.{ext}` becomes a full-resolution watermarked derivative in the original format, with image metadata preserved for download. If `watermark.json` is missing or `opacity` is `0`, processing gracefully skips watermarking.

To republish all originals after changing watermark settings, invoke the republish trigger Lambda from the CloudFormation output:

```powershell
$fn = aws cloudformation describe-stacks `
  --stack-name VictorPortfolioFoundationStack `
  --query "Stacks[0].Outputs[?OutputKey=='RepublishTriggerFunctionName'].OutputValue" `
  --output text

aws lambda invoke --function-name $fn .\.cache\republish-output.json
```

The trigger lists `originals/` and fans out one SQS message per photo. In M4, the admin UI polls queue depth and creates the CloudFront invalidation after the reprocess queue drains.

## M4 Admin UI

The admin interface is served at:

- https://victor-yeung.com/admin/

M4 adds:

- CloudFront Basic Auth for `/admin*` and `/api/admin*`
- Direct API Gateway bypass protection with a private CloudFront origin header
- React admin island for uploading originals, editing metadata, soft-delete/restore/purge, watermark settings, preview, and republish
- S3 presigned uploads for photos and PNG watermarks

Set local admin credentials before deploying:

```powershell
Copy-Item .\infra\.env.example .\infra\.env
# edit ADMIN_USERNAME and ADMIN_PASSWORD locally
```

`infra/.env` is ignored by git.

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
