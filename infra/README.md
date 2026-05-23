# Infrastructure

M1 foundation for `victor-yeung.com`.

This milestone uses AWS CDK for the core foundation and a manual PowerShell deploy script for setup and DNS migration. GitHub Actions are intentionally not included yet.

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

## Notes

The current temporary S3 website DNS record is replaced during deployment by Route 53 alias records pointing to CloudFront.
