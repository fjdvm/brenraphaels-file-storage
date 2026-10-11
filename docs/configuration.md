# Configuration

Settings the service needs. Names only; never commit values.

## Infrastructure

| Resource | Name | Notes |
| --- | --- | --- |
| R2 bucket (public) | `br-file-storage-public` | Public address enabled at `https://pub-7cfd914d85cb456bb279755ed3904a66.r2.dev` (r2.dev; verified with a test upload) |
| R2 bucket (private) | `br-file-storage-private` | No public access; reached via signed addresses only |
| Neon project | `brenraphaels-file-storage-microservice` | Region `aws-ap-southeast-1` |

The pre-existing `br-file-storage` bucket is unrelated and must not be touched.

## Settings

| Name | Purpose |
| --- | --- |
| `R2_PUBLIC_BUCKET` | Public bucket name |
| `R2_PRIVATE_BUCKET` | Private bucket name |
| `R2_PUBLIC_BASE_URL` | Public base address Public Files are served from (CDN) |
| `R2_ACCOUNT_ID` | Cloudflare account id for the S3 endpoint |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `DATABASE_URL` | Neon pooled connection string (runtime) |
| `DATABASE_URL_UNPOOLED` | Neon direct connection string (migrations) |
| `CRON_SECRET` | Shared secret authorising the daily cleanup call |
