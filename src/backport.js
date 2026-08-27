import * as core from "@actions/core";
import { parseSelectedBranches, stripTargetBlock } from "./template.js";
import { labelForBranch, desiredBranchesFromLabels } from "./labels.js";
import { branchName, branchPrefixFor } from "./naming.js";
import { configureRepo, cherryPickOntoBranch } from "./git.js";

// Lists the open backport PRs belonging to a given original PR.
async function findBackportPRs(octokit, owner, repo, prNumber) {
  const prefix = branchPrefixFor(prNumber);
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  return prs.filter((pr) => pr.head.ref.startsWith(prefix));
}

// Finds a backport PR for a branch in any state, preferring an open one.
async function findBackportPRAnyState(octokit, owner, repo, branch) {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "all",
  });
  return data.find((p) => p.state === "open") || data[0] || null;
}

// Decides whether to squash the PR's commits into one backport commit.
// `auto` squashes only when squash-merge is the repo's sole enabled method.
async function shouldSquash(octokit, owner, repo, mode) {
  if (mode === "squash") return true;
  if (mode === "individual") return false;
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return Boolean(
    data.allow_squash_merge && !data.allow_merge_commit && !data.allow_rebase_merge,
  );
}

// Copies selected metadata from the original onto a backport. Additive and
// re-run on every reconcile, so new labels/milestone/assignees/reviewers
// propagate; it never removes what a human added to the backport.
async function applyMetadata(octokit, owner, repo, original, backportNumber, metadata, labelPrefix) {
  if (metadata.copyLabels) {
    // Don't copy the backport:<branch> control labels onto the backport itself.
    const labels = (original.labels || [])
      .map((l) => l.name)
      .filter((name) => !name.startsWith(labelPrefix));
    if (labels.length) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: backportNumber,
        labels,
      });
    }
  }

  if (metadata.copyMilestone && original.milestone) {
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: backportNumber,
      milestone: original.milestone.number,
    });
  }

  if (metadata.copyAssignees) {
    const assignees = (original.assignees || []).map((a) => a.login);
    if (assignees.length) {
      await octokit.rest.issues.addAssignees({
        owner,
        repo,
        issue_number: backportNumber,
        assignees,
      });
    }
  }

  if (metadata.copyReviewers) {
    const wanted = (original.requested_reviewers || []).map((r) => r.login);
    if (wanted.length) {
      // Don't re-request reviewers already requested or who already reviewed the
      // backport: re-requesting resets an existing approval and flips readiness red.
      const { data: bp } = await octokit.rest.pulls.get({ owner, repo, pull_number: backportNumber });
      const requested = new Set((bp.requested_reviewers || []).map((r) => r.login));
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: backportNumber,
        per_page: 100,
      });
      const reviewed = new Set(reviews.map((r) => r.user && r.user.login).filter(Boolean));
      const reviewers = wanted.filter((login) => !requested.has(login) && !reviewed.has(login));
      if (reviewers.length) {
        try {
          await octokit.rest.pulls.requestReviewers({
            owner,
            repo,
            pull_number: backportNumber,
            reviewers,
          });
        } catch (error) {
          core.warning(`Could not request some reviewers on #${backportNumber}: ${error.message}`);
        }
      }
    }
  }
}

// One-time on open: seed backport:<branch> labels from the template checkboxes,
// then strip the checkbox block so labels become the single source of truth.
async function seedLabelsAndStrip({ octokit, owner, repo, original, allowedBranches, labelPrefix }) {
  const selected = parseSelectedBranches(original.body).filter((b) =>
    allowedBranches.includes(b),
  );
  if (selected.length) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: original.number,
      labels: selected.map((b) => labelForBranch(labelPrefix, b)),
    });
    core.info(`Seeded labels: ${selected.map((b) => labelForBranch(labelPrefix, b)).join(", ")}.`);
  }

  const stripped = stripTargetBlock(original.body);
  if (stripped !== original.body) {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: original.number,
      body: stripped,
    });
  }
}

// Closes a backport PR, optionally deleting its branch. Keeping the branch
// (default) makes the close reversible via a later reopen.
async function closeBackport(octokit, owner, repo, bp, deleteOnRemoval, reason) {
  await octokit.rest.pulls.update({ owner, repo, pull_number: bp.number, state: "closed" });
  core.info(`Closed backport #${bp.number} → ${bp.base.ref} (${reason}).`);
  if (deleteOnRemoval) {
    try {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${bp.head.ref}` });
      core.info(`Deleted branch ${bp.head.ref}.`);
    } catch (error) {
      core.warning(`Could not delete branch ${bp.head.ref}: ${error.message}`);
    }
  }
}

// Closes every open backport for an abandoned (closed, unmerged) original PR.
async function closeAllBackports({ octokit, owner, repo, original, deleteOnRemoval }) {
  const open = await findBackportPRs(octokit, owner, repo, original.number);
  for (const bp of open) {
    await closeBackport(octokit, owner, repo, bp, deleteOnRemoval, "original abandoned");
  }
}

// Reconciles backport PRs to match the original's backport:<branch> labels:
// creates/reopens the ones that should exist, closes ones whose label was
// removed (keeping the branch so it can be reopened). Idempotent.
async function reconcileBackports({
  octokit,
  token,
  owner,
  repo,
  original,
  allowedBranches,
  committer,
  signing,
  cherryPicking,
  metadata,
  labelPrefix,
  deleteOnRemoval,
}) {
  const desired = desiredBranchesFromLabels(original.labels, labelPrefix, allowedBranches);
  const open = await findBackportPRs(octokit, owner, repo, original.number);

  // Close backports whose label was removed. Keep the branch by default (so it
  // can be reopened); delete it too when delete-on-removal is set.
  for (const bp of open) {
    if (!desired.includes(bp.base.ref)) {
      await closeBackport(octokit, owner, repo, bp, deleteOnRemoval, "label removed");
    }
  }

  if (desired.length === 0) return;

  await configureRepo({ core, token, owner, repo, committer, signing });
  const squash = await shouldSquash(octokit, owner, repo, cherryPicking);
  const message = `${original.title} (#${original.number})`;
  core.info(`Cherry-pick mode: ${squash ? "squash" : "individual"}.`);

  for (const target of desired) {
    const branch = branchName(original.number, target);
    let existing = await findBackportPRAnyState(octokit, owner, repo, branch);
    if (existing && existing.merged_at) continue; // already backported

    // Reopen BEFORE touching the branch: GitHub refuses to reopen a PR whose
    // branch was force-pushed after it closed. Fall back to a fresh PR if so.
    if (existing && existing.state === "closed") {
      try {
        await octokit.rest.pulls.update({ owner, repo, pull_number: existing.number, state: "open" });
        core.info(`Reopened backport #${existing.number} (label re-added).`);
      } catch (error) {
        core.warning(`Could not reopen #${existing.number}, opening a new backport (${error.message}).`);
        existing = null;
      }
    }

    core.info(`Backporting #${original.number} to ${target} (${branch}).`);
    const { conflict } = await cherryPickOntoBranch({
      target,
      baseRef: original.base.ref,
      prNumber: original.number,
      branch,
      squash,
      message,
    });

    if (existing) {
      await applyMetadata(octokit, owner, repo, original, existing.number, metadata, labelPrefix);
      continue; // open or reopened — branch is now updated
    }

    const body =
      `Backport of #${original.number} to \`${target}\`.` +
      (conflict
        ? "\n\n> [!WARNING]\n> The cherry-pick hit conflicts committed in place. Resolve them before merging."
        : "");

    const { data: created } = await octokit.rest.pulls.create({
      owner,
      repo,
      base: target,
      head: branch,
      title: `[Backport ${target}] ${original.title}`,
      body,
    });
    core.info(`Opened backport PR #${created.number}.`);
    await applyMetadata(octokit, owner, repo, original, created.number, metadata, labelPrefix);
  }
}

export { seedLabelsAndStrip, reconcileBackports, closeAllBackports, findBackportPRs };
