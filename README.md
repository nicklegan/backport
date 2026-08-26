# backport

> A GitHub Action that cherry-picks a pull request onto long-running backport branches and gates the original pull request and its backports with a bidirectional, all-or-nothing merge-readiness check.

For a complete walkthrough — creating the GitHub App, branch protection, template, and workflow — see [docs/end-to-end-setup.md](docs/end-to-end-setup.md).

## Usage

The example [workflow](https://docs.github.com/actions/reference/workflow-syntax-for-github-actions) below creates the backport pull requests when an original pull request is opened, and keeps the gate checks up to date whenever a pull request in the set is updated, reviewed, or its checks complete.

```yml
name: backport

on:
  pull_request:
    types: [opened, synchronize, reopened, closed, labeled, unlabeled]
    branches: # The original PR's base (main) plus your backport branches
      - main
      - release/**
  pull_request_review:
    types: [submitted, dismissed]
  check_suite:
    types: [completed]

permissions:
  contents: read # Only actions/checkout uses the workflow token

# Give each PR its own lane so a burst of opened PRs don't cancel one another
# (a shared group would drop queued runs). A single PR's own events still
# serialize; check_suite/status have no PR number so they fall back to run_id
# and never cancel anything.
concurrency:
  group: backport-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false

jobs:
  backport:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          fetch-depth: 0 # Full history is required to cherry-pick

      - name: Create and gate backport pull requests
        uses: nicklegan/backport@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          backport-branches: |
            release/v1.x
            release/v2.x
          # check-name: 'backports-ready'
          # reverse-check-name: 'original-ready'
```

## GitHub secrets

| Name                 | Value                                    | Required |
| :------------------- | :--------------------------------------- | :------- |
| `APP_ID`             | GitHub App ID number                     | `true`   |
| `APP_PRIVATE_KEY`    | Content of the App private key .pem file | `true`   |
| `ACTIONS_STEP_DEBUG` | `true` [Enables diagnostic logging]      | `false`  |

[enables diagnostic logging]: https://docs.github.com/actions/managing-workflow-runs/enabling-debug-logging#enabling-runner-diagnostic-logging 'Enabling runner diagnostic logging'

## Action inputs

| Name                 | Description                                                      | Default           | Location       | Required |
| :------------------- | :-------------------------------------------------------------- | :---------------- | :------------- | :------- |
| `app-id`             | GitHub App ID used to derive an installation token              |                   | [workflow.yml] | `true`   |
| `private-key`        | GitHub App private key (PEM) used to derive an installation token |                 | [workflow.yml] | `true`   |
| `backport-branches`  | Allowed set of backport branches, one per line                  |                   | [workflow.yml] | `true`   |
| `check-name`         | Forward gate check reported on the original pull request         | `backports-ready` | [action.yml]   | `false`  |
| `reverse-check-name` | Reverse gate check reported on each backport pull request        | `original-ready`  | [action.yml]   | `false`  |
| `cherry-picking`     | `auto` (squash only when squash is the repo's sole merge method), `individual`, or `squash` | `auto` | [action.yml] | `false`  |
| `label-prefix`       | Prefix for backport target labels (`<prefix><branch>` selects a branch) | `backport:`    | [action.yml]   | `false`  |
| `delete-on-removal`  | On label removal, also delete the backport branch (default keeps it) | `false`           | [action.yml]   | `false`  |
| `close-backports-on-abandon` | Close backports when the original PR is closed unmerged | `true`   | [action.yml]   | `false`  |
| `copy-labels`        | Keep the original PR's labels copied to the backport (additive, re-synced)       | `false`           | [action.yml]   | `false`  |
| `copy-milestone`     | Keep the original PR's milestone copied to the backport (re-synced)              | `false`           | [action.yml]   | `false`  |
| `copy-assignees`     | Keep the original PR's assignees copied to the backport (additive, re-synced)    | `false`           | [action.yml]   | `false`  |
| `copy-reviewers`     | Keep the original PR's requested reviewers copied to the backport (additive, re-synced) | `false`   | [action.yml]   | `false`  |
| `auto-merge`         | Merge each backport once the original is merged and its checks pass | `false`        | [action.yml]   | `false`  |
| `auto-merge-method`  | Merge method for auto-merge: `merge`, `squash`, or `rebase`      | `merge`           | [action.yml]   | `false`  |
| `respect-required-only` | Gate on *required* checks only (ignore advisory ones)           | `false`           | [action.yml]   | `false`  |
| `require-conversation-resolution` | Treat unresolved review conversations as blocking     | `true`            | [action.yml]   | `false`  |
| `committer-name`     | Name used for the cherry-pick committer                          | `github-actions[bot]` | [action.yml] | `false`  |
| `committer-email`    | Email used for the cherry-pick committer                         | `github-actions[bot]@users.noreply.github.com` | [action.yml] | `false`  |
| `gpg-private-key`    | ASCII-armored GPG private key; signs cherry-picked commits        |                   | [workflow.yml] | `false`  |
| `gpg-passphrase`     | Passphrase for the GPG private key, if any                        |                   | [workflow.yml] | `false`  |
| `ssh-signing-key`    | SSH private key for signing (used when `gpg-private-key` is unset) |                  | [workflow.yml] | `false`  |

[workflow.yml]: #usage 'Usage'
[action.yml]: action.yml 'action.yml'

- :bulb: The template selects a subset of `backport-branches`; a checked branch not in this set is ignored.

## Signed commits

If a target branch requires signed commits (via classic branch protection or a ruleset), provide a signing key so the cherry-picked commits are signed — otherwise the backport can never become mergeable. GPG takes precedence over SSH.

```yaml
      - uses: nicklegan/backport@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          backport-branches: |
            release/v1.x
            release/v2.x
          gpg-private-key: ${{ secrets.GPG_PRIVATE_KEY }}
          gpg-passphrase: ${{ secrets.GPG_PASSPHRASE }}
          committer-name: your-bot
          committer-email: your-bot@users.noreply.github.com
```

- :bulb: Set `committer-name`/`committer-email` to match the signing key's verified identity so GitHub marks the commits **Verified**.
- :bulb: Register the key on the signing account (GPG or SSH signing key) for verification to succeed.

## Backport labels

Backports are driven by **labels** — `backport:<branch>` is the single source of truth for which branches a PR is backported to:

- **Add** `backport:release/v2.x` → the backport PR is created (or reopened).
- **Remove** it → the backport PR is **closed** (its branch is kept, so re-adding reopens it).
- With `delete-on-removal: true`, removing a label also **deletes** the backport branch (re-adding then opens a fresh backport).
- Closing the original PR **without merging** closes its backports too (like removing all labels); disable with `close-backports-on-abandon: false`. A **merged** original is unaffected — its backports proceed.
- Runs on `opened`/`synchronize`/`reopened`/`labeled`/`unlabeled`, always reconciling the open backports to match the current labels. Fully idempotent.

The label prefix is configurable via `label-prefix` (default `backport:`). Only labels whose branch is in `backport-branches` are honored.

## Pull request template

The template exists only to make the choice at **open** (GitHub can't auto-apply labels from a template). On open, the action reads the checked boxes, converts them to `backport:<branch>` labels, and **removes the checkbox block** — so after open there is exactly one place to manage backports: the labels.

Wrap the block in markers so it can be stripped cleanly ([full template](docs/pull-request-template.md)):

```md
<!-- backport-targets:start -->

## Backport targets

- [ ] release/v1.x
- [x] release/v2.x

<!-- backport-targets:end -->
```

- :bulb: Make the template mandatory using GitHub's own [pull request template](https://docs.github.com/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository) feature.
- :bulb: The template is **optional** — the action is label-driven. Its only job is picking targets at **open**, which matters most for outside/fork contributors who can edit the PR body but can't set labels. If everyone opening PRs can add labels, skip the template and manage targets with `backport:*` labels directly.

## Status checks

The action reports two required checks that form a mutual, all-or-nothing barrier. Neither the original pull request nor its backports can merge until every pull request in the set is independently mergeable — none of them has to be *merged*. "Mergeable" is computed from individual non-circular signals (no conflicts, `reviewDecision`, resolved conversations, and the status/check rollup), excluding both gate checks so the mutual dependency does not deadlock.

| Check                | Reported on        | Conclusion                                                     |
| :------------------- | :----------------- | :------------------------------------------------------------ |
| `backports-ready`    | The original PR    | `success` when every backport PR is mergeable                 |
| `original-ready`     | Each backport PR   | `success` when the original PR is mergeable                   |

- :bulb: Require `backports-ready` on your main branch and `original-ready` on each backport branch in branch protection.
- :bulb: An original pull request with no backports (main only) still gets a green `backports-ready` so the required check always resolves.
- :bulb: By default the gate is stricter than branch protection — *every* non-gate check and *every* review thread must pass, not only the required ones (so it can be conservatively red, never falsely green). Set `respect-required-only: true` to gate on required checks only, and `require-conversation-resolution: false` if your branches don't require resolved conversations.

## Auto-merge

By default the action never merges — humans do. With `auto-merge: true`, once the **original PR is merged**, each backport is merged automatically as soon as its own checks pass (no conflicts, CI green, approvals satisfied). Backports never merge before the original.

It enables GitHub-native auto-merge on each backport (falling back to a direct merge when a backport is already mergeable), so GitHub handles the "wait for checks" timing.

- :bulb: Enable **Allow auto-merge** in the repository settings.
- :bulb: Add `closed` to the `pull_request` trigger types so the action reacts when the original is merged.
- :bulb: A backport with conflicts stays open (auto-merge waits) until a human resolves it.

## GitHub App authentication

The action authenticates as a GitHub App and derives an installation token itself, so the backport pull requests it opens trigger their own CI (which the `github-actions` default token would not).

[Register](https://docs.github.com/developers/apps/building-github-apps/creating-a-github-app) a new GitHub App with the below permissions:

| GitHub App Permission                    | Access           |
| :--------------------------------------- | :--------------- |
| `Repository Permissions:Contents`        | `read and write` |
| `Repository Permissions:Pull requests`   | `read and write` |
| `Repository Permissions:Checks`          | `read and write` |
| `Repository Permissions:Commit statuses` | `read`           |
| `Repository Permissions:Metadata`        | `read` (mandatory) |

After registration [install the GitHub App](https://docs.github.com/developers/apps/managing-github-apps/installing-github-apps) on your repository. Store the below App values as secrets.

### GitHub App secrets

| Name              | Value                                    | Required |
| :---------------- | :--------------------------------------- | :------- |
| `APP_ID`          | GitHub App ID number                     | `true`   |
| `APP_PRIVATE_KEY` | Content of the App private key .pem file | `true`   |

## Development

```sh
npm install
npm test       # Runs the unit tests (node --test)
npm run build  # Bundles src/ into dist/ with esbuild; commit dist/
```
