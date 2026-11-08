# Deploy to Azure Container Apps

Tracked by [Ticket#155](https://github.com/fjdvm/brenraphaels-authentication-microservice/issues/155) (Spec#138). Replaces the ACR-based plan in #31.

Every push to `main` runs `.github/workflows/container.yml`: typecheck, tests, build the image, smoke-test it against a disposable Postgres (health, gateway secret, one authenticated upload request), then apply pending migrations, push to GHCR and deploy Container App `file-storage` in `rg-brenraphaels` / `cae-brenraphaels` with **min 0, max 2 replicas**. The first request after idle wakes a replica (cold start of a few seconds).

## Repository secrets and variables

| Name | Kind | Value |
| --- | --- | --- |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | secret | OIDC login (Ticket#141) |
| `GHCR_PULL_TOKEN`, `GHCR_USERNAME` | secret / variable | read:packages pull token (Ticket#141) |
| `DATABASE_URL` | secret | Neon pooled connection (runtime) |
| `DATABASE_URL_UNPOOLED` | secret | Neon direct connection (migrations, run in CI) |
| `FILE_STORAGE_URL` | variable | Azure HTTPS base address used by nightly cleanup |
| `GATEWAY_SECRET`, `CRON_SECRET` | secret | see [configuration](../configuration.md) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret | R2 API token |
| `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BASE_URL` | variable | bucket names and public address |

Secrets become Container App secrets referenced by env vars of the same name. No data moves: the database stays on Neon and Files stay in R2.

## Cleanup

The daily `/cron/cleanup` call comes from `.github/workflows/cleanup.yml` at 03:00 UTC with `Authorization: Bearer $CRON_SECRET`. It can also be dispatched manually. See [cleanup](../cleanup.md) for configuration and recovery.

## Switching callers

The workflow prints the app's default `*.azurecontainerapps.io` address. Callers move to `files.buildwrite.me` in a later cutover ticket.
