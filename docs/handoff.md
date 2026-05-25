# Victor Portfolio Handoff

## URLs

- Public site: https://victor-yeung.com
- Admin: https://victor-yeung.com/admin/
- Contact API: https://victor-yeung.com/api/contact
- SES identities: https://us-west-2.console.aws.amazon.com/sesv2/home?region=us-west-2#/identities
- CloudWatch log groups: https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#logsV2:log-groups
- CloudFormation stacks: https://us-west-2.console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks

## Deploy

Run from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy.ps1
```

The script builds CDK, deploys both stacks, builds Astro, seeds `data/site.json` if it does not exist, regenerates `data/gallery.json`, syncs `site/dist` to S3, and invalidates CloudFront.

## Critical Env Vars

| Variable | File | Purpose | If missing |
| --- | --- | --- | --- |
| `ADMIN_USERNAME` | `infra/.env` | Admin Basic Auth user | CDK deploy stops |
| `ADMIN_PASSWORD` | `infra/.env` | Admin Basic Auth password | CDK deploy stops |
| `CONTACT_TO_EMAIL` | `infra/.env` | Inbox for contact submissions | CDK deploy stops |
| `CONTACT_FROM_EMAIL` | `infra/.env` | SES sender identity, usually `noreply@victor-yeung.com` | CDK deploy stops |
| `ADMIN_ALERT_EMAIL` | `infra/.env` | SNS alert recipient for DLQ alarms and DMARC reports | CDK deploy stops |
| `TURNSTILE_SECRET_KEY` | `infra/.env` | Server-side Cloudflare Turnstile verification | Turnstile check is skipped |
| `PUBLIC_GA_ID` | `site/.env` | Google Analytics measurement ID | Analytics is disabled |
| `PUBLIC_TURNSTILE_SITEKEY` | `site/.env` | Client-side Turnstile widget key | Widget is hidden |

`infra/.env` and `site/.env` are local-only and ignored by git.

## Pre-Launch SES Verification

The infrastructure creates a domain identity for `victor-yeung.com` with DKIM, plus a Gmail email identity for the sandbox recipient address. If SES sends a verification email for the recipient identity after a deploy:

1. Open the Gmail inbox for the contact sender address.
2. Find the AWS verification email. The subject is usually similar to `Amazon Web Services - Email Address Verification Request in region US West (Oregon)`.
3. Click the verification link in that email.
4. Confirm the identity status in the SES console: https://us-west-2.console.aws.amazon.com/sesv2/home?region=us-west-2#/identities

The contact form can return `500` until the sender domain and sandbox recipient identity are verified. This is an operator step, not a code failure.

## AWS Cost Summary

Expected cost at current scale is about `$1-2/month`.

| Service | Expected cost | Notes |
| --- | ---: | --- |
| Route 53 hosted zone | about `$0.50/month` | Fixed hosted-zone charge |
| CloudFront | usually free tier | Traffic is low; invalidations are minimal |
| S3 | pennies | Site files and photo variants are small |
| Lambda | usually free tier | Admin/contact/image processing volume is low |
| SQS/SNS | pennies | Only republish and failure alerts |
| SES | pennies | Contact form sends to one inbox |

Costs can rise if traffic or photo storage grows. Free-tier coverage depends on the AWS account age and current AWS pricing.

## What Runs Where

| URL or job | AWS resource |
| --- | --- |
| `/`, `/about`, `/contact` | CloudFront to private `victor-yeung-site` S3 bucket |
| `/admin/*` | CloudFront to private site bucket with Basic Auth function |
| `/api/admin/*` | CloudFront to HTTP API to `AdminApi` Lambda |
| `/api/contact` | CloudFront to HTTP API to `ContactApi` Lambda |
| `/photos/*` | CloudFront to private `victor-yeung-photos` S3 bucket |
| `/data/gallery.json`, `/data/site.json` | CloudFront to private photos bucket |
| Other `/data/*` | Blocked by CloudFront function |
| Original upload processing | `ImageProcessor` Lambda |
| Republish all photos | `RepublishTrigger` Lambda plus SQS queue |

## Public Data

The public site fetches:

- `/data/gallery.json`
- `/data/site.json`

`data/gallery.json` is public-safe. It excludes soft-deleted photos and internal keys such as `originalKey`. Admin and Lambda code still use `data/photos.json` directly in S3.

## Admin Workflows

Upload photos:

1. Open https://victor-yeung.com/admin/
2. Use the Photos tab to upload image files.
3. Wait for processing to complete.
4. Edit title, description, order, album, and tags.

Soft-delete photos:

1. Open the Photos tab.
2. Click `Soft Delete`.
3. The photo disappears from the public gallery after the `/data/*` cache TTL or the next invalidation.

Change watermark:

1. Open the Watermark tab.
2. Upload a PNG watermark or adjust settings.
3. Save.
4. Open Republish and run `Republish All` so existing photos are regenerated.

Edit site info:

1. Open the Site Info tab.
2. Edit name, tagline, rich bio, email, social links, and footer.
3. Save.
4. Public About and footer update after the `/data/*` cache TTL.

## Contact Form Submissions

Submissions arrive in Victor's inbox through SES. There is no admin dashboard for submissions.

Reply directly from Gmail. The Lambda sets the submitter's email as `Reply-To`, so replies should go to the person who filled out the form.

If `TURNSTILE_SECRET_KEY` and `PUBLIC_TURNSTILE_SITEKEY` are empty, the form still works but has no Turnstile spam protection.

## Debugging Common Issues

| Symptom | First checks |
| --- | --- |
| Contact form returns `500` | Check SES verification first, then the ContactApi CloudWatch log group |
| Contact form returns `400` | Check required fields and Turnstile configuration |
| Photos missing after upload | Check the ImageProcessor log group for Sharp or S3 errors |
| Admin credentials rejected | Confirm `infra/.env` matches the last deployed credentials |
| Republish never finishes | Check SQS queue depth and ImageProcessor logs |
| DLQ alarm email arrives | Open ImageProcessor logs, inspect the failed original, then republish after fixing |
| Public gallery stale | Wait about one minute or create a CloudFront invalidation |

CloudWatch logs: https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#logsV2:log-groups

Helpful stack outputs:

- `ImageProcessorFunctionName`
- `RepublishTriggerFunctionName`
- `ContactApiFunctionName`
- `ImageReprocessQueueUrl`
- `DistributionId`

## Admin Password Rotation

1. Edit `ADMIN_USERNAME` and/or `ADMIN_PASSWORD` in `infra/.env`.
2. Run the deploy script.
3. Wait for CloudFront propagation, usually about one minute.
4. The old credentials stop working after the CloudFront Function update reaches the edge.

Do not commit `infra/.env`.

## SES Bounce And Complaint Handling

There is currently no bounce or complaint SNS subscription. At this launch scale, that is acceptable because the form sends to a single verified inbox. Add SES event destinations later if mail volume grows or deliverability needs deeper monitoring.

## DKIM And Deliverability

M5 currently uses an SES email identity rather than a full domain identity with DKIM records. Early contact-form emails may land in Gmail spam. Mark the first valid messages as not spam to train the inbox.

A future improvement is SES domain verification for `victor-yeung.com` with DKIM DNS records in Route 53.

## Rollback

For a broken site content deploy, restore a previous S3 object version and invalidate CloudFront. For infrastructure issues, revert the code and rerun the deploy script. See the Rollback sections in [README.md](../README.md) and [infra/README.md](../infra/README.md).
