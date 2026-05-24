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
- Image processor Lambda triggered by S3 changes under `originals/`
- Sharp Lambda layer for WebP variant generation and watermark compositing
- SQS queue and DLQ for republishing all image variants
- Republish trigger Lambda for enqueueing all originals
- Basic-auth protected admin UI and admin API behind CloudFront

## Image Pipeline

Upload originals to `s3://victor-yeung-photos/originals/{id}.{ext}`. Supported extensions are `jpg`, `jpeg`, `png`, `webp`, `tif`, `tiff`, and `avif`.

For each uploaded original, the Lambda writes:

- `thumb/{id}.webp`
- `medium/{id}.webp`
- `full/{id}.{ext}` as the original uploaded image
- `data/photos.json`

Deleting an original deletes the generated assets and removes the metadata entry. The Lambda updates `data/photos.json` with conditional S3 writes and retries on ETag conflicts.

## Watermark And Reprocess

Watermarking is optional. If `data/watermark.json` does not exist, or if `opacity` is `0`, the image processor writes unwatermarked variants and logs no error.

Expected config:

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

The watermark width is calculated from each finished variant's width, which keeps the Width % slider visually consistent across landscape, portrait, and square images. Margin is calculated from the shorter side. The processor supports all nine anchors: `top-left`, `top-center`, `top-right`, `middle-left`, `middle-center`, `middle-right`, `bottom-left`, `bottom-center`, and `bottom-right`.

`thumb` and `medium` are watermarked WebP display variants. `full/{id}.{ext}` is a full-resolution watermarked derivative in the original format, with image metadata preserved for downloads.

After changing watermark settings, invoke the republish trigger:

```powershell
$fn = aws cloudformation describe-stacks `
  --stack-name VictorPortfolioFoundationStack `
  --query "Stacks[0].Outputs[?OutputKey=='RepublishTriggerFunctionName'].OutputValue" `
  --output text

aws lambda invoke --function-name $fn .\.cache\republish-output.json
```

The trigger paginates `originals/` and sends one SQS message per original. The image processor consumes the SQS queue with batch size `1`; failed messages are retried up to three receives before moving to `image-reprocess-dlq`. In M4, the admin UI polls queue depth and creates the CloudFront invalidation after the queue drains.

## Admin

The admin UI is available at:

```text
https://victor-yeung.com/admin/
```

Set deploy-time Basic Auth credentials before CDK synth/deploy. The deploy script loads `infra/.env` automatically:

```powershell
Copy-Item .\infra\.env.example .\infra\.env
# edit ADMIN_USERNAME and ADMIN_PASSWORD locally
```

Do not commit `infra/.env`. The CloudFront Function protects `/admin*` and `/api/admin*`. The admin API also requires a private CloudFront origin header so the public API Gateway URL cannot bypass Basic Auth.

## Deploy

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-m1.ps1
```

The script expects:

- AWS CLI v2 configured with the `default` profile
- Node.js 22+ with npm available
- Existing Route 53 hosted zone `victor-yeung.com`
- `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `infra/.env` or the current shell

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
