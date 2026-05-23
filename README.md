# Victor Portfolio

Personal portfolio website for Victor Yeung, focused on art and photography.

## Current State

The M1 foundation is live at:

- https://victor-yeung.com

The site is served by CloudFront over HTTPS from a private S3 bucket and includes the Google Analytics tag `G-8EK1C2QSY7`.

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

## Launch Decisions

- `www.victor-yeung.com` redirects to `victor-yeung.com`
- Full-size watermarked images are downloadable
- Launch with a single curated gallery
- Admin delete starts as soft-delete
- Full admin system ships before public launch

## Previous Temporary Site

The earlier HTTP-only S3 website bucket was replaced by M1 DNS records pointing to CloudFront. The temporary deployment files were removed from this branch to avoid accidentally restoring the old HTTP-only path.
