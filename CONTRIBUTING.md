# Contributing

Open an issue with a minimal, synthetic reproduction or proposed improvement. Fork the repository and submit a pull request to `main`. Issues and pull requests do not grant write access. Never submit recordings, private transcripts, credentials or generated user documents.

All changes go through a pull request, passing CI and resolved review conversations. The repository owner reviews contributions through CODEOWNERS. The sole owner may bypass the approval requirement only when merging a pull request; this exception does not bypass CI, permit direct pushes, force pushes or deletion of `main`. GitHub does not allow authors to approve their own pull requests.

Run `npm run typecheck`, `npm test`, `npm run build:server`, and the tests/build under `clients/even`. Stage explicit reviewed paths and run `npm run audit:public`. The source audit is a guardrail, not a replacement for reviewing every diff.

CI uses GitHub-hosted runners with read-only permissions and no application credentials. External contributors' workflows require maintainer approval: inspect workflow changes and code before approving execution. Never introduce `pull_request_target` execution of contributor code, self-hosted runners for public PRs, or secrets in PR tests. Actions must be pinned to full commit hashes. Dependency updates are reviewed, not auto-merged.
