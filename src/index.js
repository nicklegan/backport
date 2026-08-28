import * as core from "@actions/core";
import { context } from "@actions/github";
import { readConfig } from "./config.js";
import { authenticate } from "./auth.js";
import { seedLabelsAndStrip, reconcileBackports, closeAllBackports, findBackportPRs } from "./backport.js";
import { syncAll } from "./gate.js";
import { originalPrNumberFromBranch } from "./naming.js";

function isBackportPR(pr) {
  return originalPrNumberFromBranch(pr.head.ref) !== null;
}

// A PR whose head lives in a different repo (fork). Cherry-picking and pushing
// require write access the fork context can't grant, so skip creating backports.
function isForkPR(pr) {
  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;
  return Boolean(head && base && head !== base);
}

async function getPR(octokit, owner, repo, number) {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  return data;
}

// Resolves any PR (original or backport) to its original PR and re-syncs both
// gates. Skips unrelated PRs that neither are backports nor have any backports.
async function syncForPR(ctx, pr) {
  const backportOf = originalPrNumberFromBranch(pr.head.ref);
  const originalNumber = backportOf !== null ? backportOf : pr.number;

  if (backportOf === null) {
    const backports = await findBackportPRs(ctx.octokit, ctx.owner, ctx.repo, originalNumber);
    if (backports.length === 0) return;
  }

  const original = await getPR(ctx.octokit, ctx.owner, ctx.repo, originalNumber);
  await syncAll({ ...ctx, original });
}

async function handlePullRequest(ctx, payload) {
  const pr = payload.pull_request;
  const action = payload.action;

  // A backport PR's own event only affects the gate, never the selection.
  if (isBackportPR(pr)) {
    await syncForPR(ctx, pr);
    return;
  }

  // Original PR merged/closed: re-sync so the reverse gate reflects the merge
  // and auto-merge (if enabled) can proceed. An abandoned (closed, unmerged)
  // original optionally closes its backports, mirroring label removal.
  if (action === "closed") {
    const abandoned = !pr.merged;
    if (abandoned && ctx.closeBackportsOnAbandon) {
      const original = await getPR(ctx.octokit, ctx.owner, ctx.repo, pr.number);
      await closeAllBackports({ ...ctx, original });
      await syncAll({ ...ctx, original });
    } else {
      await syncForPR(ctx, pr);
    }
    return;
  }

  if (isForkPR(pr)) {
    core.warning(`Skipping backports for fork PR #${pr.number} (head in a different repo).`);
    return;
  }

  // On open, seed labels from the template checkboxes and strip the block.
  if (action === "opened") {
    const opened = await getPR(ctx.octokit, ctx.owner, ctx.repo, pr.number);
    await seedLabelsAndStrip({ ...ctx, original: opened });
  }

  // Labels are the source of truth: reconcile backports to match, then gate.
  if (["opened", "synchronize", "reopened", "labeled", "unlabeled"].includes(action)) {
    const original = await getPR(ctx.octokit, ctx.owner, ctx.repo, pr.number);
    await reconcileBackports({ ...ctx, original });
    await syncAll({ ...ctx, original });
  }
}

// check_suite / check_run / status are repo-level; resolve the commit to its PRs
// and re-sync anything related to a backport chain we manage.
async function handleCommitEvent(ctx, payload) {
  const sha =
    payload.check_suite?.head_sha ||
    payload.check_run?.head_sha ||
    payload.sha;
  if (!sha) return;

  const { data: prs } =
    await ctx.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: ctx.owner,
      repo: ctx.repo,
      commit_sha: sha,
    });

  const seen = new Set();
  for (const pr of prs) {
    const originalNumber = isBackportPR(pr)
      ? originalPrNumberFromBranch(pr.head.ref)
      : pr.number;
    if (seen.has(originalNumber)) continue;
    seen.add(originalNumber);
    await syncForPR(ctx, pr);
  }
}

async function run() {
  try {
    const config = readConfig();
    const { owner, repo } = context.repo;
    const { octokit, token } = await authenticate(
      config.appId,
      config.privateKey,
      owner,
      repo,
    );

    const ctx = {
      octokit,
      token,
      owner,
      repo,
      allowedBranches: config.allowedBranches,
      checkName: config.checkName,
      reverseCheckName: config.reverseCheckName,
      committer: config.committer,
      signing: config.signing,
      cherryPicking: config.cherryPicking,
      metadata: config.metadata,
      autoMerge: config.autoMerge,
      autoMergeMethod: config.autoMergeMethod,
      respectRequiredOnly: config.respectRequiredOnly,
      requireConversationResolution: config.requireConversationResolution,
      labelPrefix: config.labelPrefix,
      deleteOnRemoval: config.deleteOnRemoval,
      closeBackportsOnAbandon: config.closeBackportsOnAbandon,
    };

    switch (context.eventName) {
      case "pull_request":
      case "pull_request_target":
        await handlePullRequest(ctx, context.payload);
        break;
      case "pull_request_review":
        await syncForPR(ctx, context.payload.pull_request);
        break;
      case "check_suite":
      case "check_run":
      case "status":
        await handleCommitEvent(ctx, context.payload);
        break;
      default:
        core.info(`Ignoring unsupported event: ${context.eventName}.`);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
