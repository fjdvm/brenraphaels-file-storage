# Daily cleanup

`GET /cron/cleanup` runs daily at 03:00 UTC, scheduled in `.github/workflows/cleanup.yml`. GitHub Actions
sends `Authorization: Bearer $CRON_SECRET`; any other call returns 401 and changes nothing.
The route sits outside the Client System checks.

Each run:

- deletes expired Temporary Files like a Delete (all objects under the File's prefix,
  Variants and Links removed, row marked `deleted`), audited as `file.deleted`;
- discards Pending uploads older than 24 hours (objects and row), audited as
  `file.pending_discarded`;
- discards replacement staging objects requested more than 24 hours ago (the File is
  unchanged), audited as `file.replacement_discarded`. Requests made before the time was
  recorded are stamped on the first run and discarded 24 hours later.

Audit entries use system code `CRON` and actor id `cron`. Migration `0007_cron_audit.sql`
drops the audit table's foreign key to `client_systems` so this is possible; apply it
before deploying. `CRON_SECRET` must be set in GitHub repository secrets and in the Azure Container App.

Each run handles at most 200 Files per kind; the next run continues. Each File is handled in its own transaction under its row lock, re-checking the condition.
A failure on one File is logged and the rest continue; the response is 500 with counts if
any failed, and the next run retries. Reads already treat expired Files as gone.

The workflow also supports manual dispatch (`gh workflow run cleanup.yml`). Set the
`FILE_STORAGE_URL` repository variable to the Azure HTTPS base address. Each run
checks missing and incorrect secrets return 401, then requires HTTP 200 from the
authenticated cleanup. Requests have time limits for scale-to-zero cold starts;
cleanup is not automatically retried. Runs are serialized to avoid overlap.
GitHub scheduled runs use the default branch and can be delayed by GitHub.
Inspect failures in the Actions tab and rerun manually after resolving the cause.

Cutover verified by [manual Azure run](https://github.com/fjdvm/brenraphaels-file-storage/actions/runs/42524036589) on 2026-11-08 UTC before removing the Vercel cron entry.
