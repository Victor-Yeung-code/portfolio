# Victor Portfolio Handoff

## URLs

- Public site: https://victor-yeung.com
- Admin: https://victor-yeung.com/admin/
- Contact API: https://victor-yeung.com/api/contact

## Deploy

Run from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-m1.ps1
```

The script builds CDK, deploys both stacks, builds Astro, seeds `data/site.json` if it does not exist, regenerates `data/gallery.json`, syncs `site/dist` to S3, and invalidates CloudFront.

## Environment

`infra/.env` is local-only and ignored by git. Required:

```text
ADMIN_USERNAME=...
ADMIN_PASSWORD=...
```

Optional:

```text
CONTACT_TO_EMAIL=victoryeung564@gmail.com
CONTACT_FROM_EMAIL=victoryeung564@gmail.com
ADMIN_ALERT_EMAIL=victoryeung564@gmail.com
TURNSTILE_SECRET_KEY=
```

`site/.env` is local-only. Optional:

```text
PUBLIC_GA_ID=G-8EK1C2QSY7
PUBLIC_TURNSTILE_SITEKEY=
```

## Contact Email

M5 creates an SES email identity for `CONTACT_FROM_EMAIL`. AWS sends a verification email to that address. The contact form will not deliver mail until the verification link is accepted. Because the current sender and recipient are both `victoryeung564@gmail.com`, one verified identity is enough while the AWS account remains in the SES sandbox.

Turnstile is intentionally optional until the Cloudflare account is ready. Once keys exist, set both Turnstile env vars above and redeploy.

## Public Data

The public gallery fetches:

- `/data/gallery.json`
- `/data/site.json`

CloudFront blocks other `/data/*` files from public access. Admin and Lambda code still read/write `data/photos.json` directly in S3.

## Admin Checks

- Upload photos from the Photos tab.
- Edit title/order/tags there.
- Soft-delete photos to remove them from the public gallery without purging files.
- Edit public bio/footer/social links from Site Info.
- Change watermark settings, then use Republish to regenerate existing variants.
