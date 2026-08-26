import * as core from "@actions/core";
import { findBackportPRs } from "./backport.js";
import { evaluateReadiness } from "./readiness.js";

const TITLES = { ready: "Ready", pending: "Waiting", blocked: "Not ready" };

async function postCheck(octokit, owner, repo, name, headSha, state, summary) {
  const params = {
    status: state === "pending" ? "in_progress" : "completed",
    ...(state === "ready"
      ? { conclusion: "success" }
      : state === "blocked"
      ? { conclusion: "failure" }
      : {}),
    output: { title: TITLES[state], summary: summary || "" },
  };

  // Update the existing check run for this name/commit instead of stacking new ones.
  const existing = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: name,
  });
  if (existing.data.total_count > 0) {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: existing.data.check_runs[0].id,
      ...params,
    });
  } else {
    await octokit.rest.checks.create({ owner, repo, name, head_sha: headSha, ...params });
  }
}

// All-or-nothing: any blocked wins, else any pending, else all ready.
function aggregate(states) {
  if (states.some((s) => s === "blocked")) return "blocked";
  if (states.some((s) => s === "pending")) return "pending";
  return "ready";
}

// Enables GitHub-native auto-merge so the backport merges once its required
// checks pass. Falls back to a direct merge when the PR is already mergeable
// (native auto-merge rejects an already-clean PR).
async function autoMergeBackport(octokit, owner, repo, backport, method) {
  const mutation = `mutation($id: ID!, $m: PullRequestMergeMethod!) {
    enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $m }) { clientMutationId }
  }`;
  try {
    await octokit.graphql(mutation, { id: backport.node_id, m: method.toUpperCase() });
    core.info(`Enabled auto-merge on backport #${backport.number}.`);
  } catch (error) {
    try {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: backport.number,
        merge_method: method,
      });
      core.info(`Merged backport #${backport.number}.`);
    } catch (mergeError) {
      core.warning(`Auto-merge of #${backport.number} could not be completed: ${mergeError.message}`);
    }
  }
}

// Recomputes both gates for an original PR and all its backports in one pass:
// - `backports-ready` on the original, aggregating each backport's readiness.
// - `original-ready` on each backport, from the original's readiness.
// Both computations exclude the two gate checks to avoid a circular deadlock.
async function syncAll({
  octokit,
  owner,
  repo,
  original,
  checkName,
  reverseCheckName,
  autoMerge,
  autoMergeMethod,
  respectRequiredOnly,
  requireConversationResolution,
}) {
  const exclude = [checkName, reverseCheckName];
  const backports = await findBackportPRs(octokit, owner, repo, original.number);

  if (backports.length === 0) {
    await postCheck(
      octokit,
      owner,
      repo,
      checkName,
      original.head.sha,
      "ready",
      "No backport PRs are associated with this pull request.",
    );
    core.info(`Synced #${original.number}: no backports, gate green.`);
    return;
  }

  // A merged original is the strongest form of "ready" for the reverse gate.
  const originalMerged = original.merged === true;
  const originalReadiness = originalMerged
    ? { state: "ready", reason: "original merged" }
    : await evaluateReadiness({ octokit, owner, repo, number: original.number, exclude, respectRequiredOnly, requireConversationResolution });

  const backportStates = [];
  const lines = [];
  for (const bp of backports) {
    const r = await evaluateReadiness({ octokit, owner, repo, number: bp.number, exclude, respectRequiredOnly, requireConversationResolution });
    backportStates.push(r.state);
    lines.push(`- #${bp.number} → \`${bp.base.ref}\`: **${r.state}** (${r.reason})`);

    await postCheck(
      octokit,
      owner,
      repo,
      reverseCheckName,
      bp.head.sha,
      originalReadiness.state,
      `Original #${original.number} is **${originalReadiness.state}** (${originalReadiness.reason}).`,
    );
  }

  const forwardState = aggregate(backportStates);
  await postCheck(
    octokit,
    owner,
    repo,
    checkName,
    original.head.sha,
    forwardState,
    lines.join("\n"),
  );

  // Once the original is merged, optionally merge each backport when it's ready.
  if (autoMerge && originalMerged) {
    for (const bp of backports) {
      await autoMergeBackport(octokit, owner, repo, bp, autoMergeMethod);
    }
  }

  core.info(
    `Synced #${original.number}: backports-ready=${forwardState}, original=${originalReadiness.state}.`,
  );
}

export { syncAll };
