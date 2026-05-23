# Victor Portfolio

Personal portfolio website for Victor Yeung, focused on art and photography.

## Current State

The temporary test site is live at:

- http://victor-yeung.com

It currently serves a simple `Hello world` page from an S3 static website bucket and includes the Google Analytics tag `G-8EK1C2QSY7`.

## Target Architecture

The production version will move to:

- Astro frontend
- AWS CDK in TypeScript for infrastructure
- Private S3 buckets behind CloudFront Origin Access Control
- ACM certificate for HTTPS
- Route 53 DNS
- Lambda-based image pipeline
- Admin UI for uploads, metadata, watermark settings, and soft-delete

## Launch Decisions

- `www.victor-yeung.com` redirects to `victor-yeung.com`
- Full-size watermarked images are downloadable
- Launch with a single curated gallery
- Admin delete starts as soft-delete
- Full admin system ships before public launch

## Temporary Deployment

The files in the repo root are the temporary S3 website setup:

- `index.html`
- `deploy-static-site.ps1`
- `aws-website.json`
- `aws-bucket-policy.json`
- `aws-route53-change.json`

Run this to redeploy the temporary site:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-static-site.ps1
```

M1 will replace the temporary public S3 website setup with CloudFront + HTTPS + private S3.
