## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (fjdvm/brenraphaels-file-storage) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Workflow

### Pull requests

When work is done, always open a pull request (`gh pr create`, using the `/pr` skill for the body). Never leave finished work only committed locally or on `main`.

### Closing issues

Every pull request closes the issue it implements. Put `Closes #<number>` in the PR body so GitHub closes the issue automatically when the PR merges. GitHub only does this for PRs into the default branch (`main`); for a PR into any other branch, close the issue yourself with `gh issue close <number>` once the work reaches `main`.
