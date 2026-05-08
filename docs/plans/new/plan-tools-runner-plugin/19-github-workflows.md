# Step 19: GitHub Workflows

Create CI and publish workflows.

## What to create

### 19.1. `.github/workflows/ci.yml`

- Triggers on `push` and `pull_request` (all branches).
- Single job `ci` on `ubuntu-latest`.
- Steps:
  1. `actions/checkout@v4`
  2. `oven-sh/setup-bun@v2` with `bun-version: latest`
  3. Install dependencies: `bun install`
  4. Compile: `bun run compile`
  5. Test: `bun run test`
  6. Bundle: `bun run bundle`
  7. Smoke tests (e2e): `bash scripts/smoke-tests.sh`
  8. Smoke tests (hook sanity): `bash scripts/hook-smoke-tests.sh`

### 19.2. `.github/workflows/publish.yml`

- Triggers on `push` of tags matching `v*.*.*`.
- Single job `publish` on `ubuntu-latest`.
- Steps: identical to CI above, followed by:
  - A `Publish` step with a shell block containing `# TODO: publish to Claude marketplace here` and `exit 1` so the workflow fails loudly until real publish logic is wired in.

## Verification

- Both files exist at `.github/workflows/ci.yml` and `.github/workflows/publish.yml`.
- Both are valid YAML (parse without error).
- The `ci.yml` job runs on `push` and `pull_request`.
- The `publish.yml` job runs only on `v*.*.*` tag pushes.

## Summary

_To be completed when this step is implemented._
