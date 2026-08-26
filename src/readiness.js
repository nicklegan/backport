// Computes whether a PR is genuinely mergeable, reconstructed from individual
// non-circular signals rather than the aggregate `mergeable_state` (which folds
// in the mutual gate checks and would deadlock the bidirectional gate).
// The two gate checks are always excluded from the status rollup. When
// `respectRequiredOnly` is set, non-required checks are ignored too, using the
// GraphQL `isRequired` signal (which reflects branch protection and rulesets).
const QUERY = `query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      isDraft
      mergeable
      reviewDecision
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
                  ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const OK_CONCLUSIONS = ["SUCCESS", "NEUTRAL", "SKIPPED"];

// GitHub computes `mergeable` asynchronously and emits no event when it settles,
// so poll briefly when it's UNKNOWN to avoid the gate getting stuck pending.
const MERGEABLE_POLL_ATTEMPTS = 5;
const MERGEABLE_POLL_INTERVAL_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPullRequest(octokit, owner, repo, number) {
  const data = await octokit.graphql(QUERY, { owner, repo, number });
  return data.repository.pullRequest;
}

// Returns { state: "ready" | "pending" | "blocked", reason }.
async function evaluateReadiness({
  octokit,
  owner,
  repo,
  number,
  exclude = [],
  respectRequiredOnly = false,
  requireConversationResolution = true,
}) {
  let pr = await fetchPullRequest(octokit, owner, repo, number);
  for (
    let attempt = 0;
    pr.mergeable === "UNKNOWN" && attempt < MERGEABLE_POLL_ATTEMPTS;
    attempt++
  ) {
    await sleep(MERGEABLE_POLL_INTERVAL_MS);
    pr = await fetchPullRequest(octokit, owner, repo, number);
  }

  if (pr.isDraft) return { state: "blocked", reason: "draft" };
  if (pr.mergeable === "CONFLICTING")
    return { state: "blocked", reason: "merge conflicts" };
  if (
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.reviewDecision === "REVIEW_REQUIRED"
  )
    return { state: "blocked", reason: "reviews not satisfied" };
  if (
    requireConversationResolution &&
    (pr.reviewThreads.nodes || []).some((t) => !t.isResolved)
  )
    return { state: "blocked", reason: "unresolved conversations" };

  let pending = pr.mergeable === "UNKNOWN";

  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes || [];
  for (const c of contexts) {
    if (c.__typename === "CheckRun") {
      if (exclude.includes(c.name)) continue;
      if (respectRequiredOnly && !c.isRequired) continue;
      if (c.status !== "COMPLETED") pending = true;
      else if (!OK_CONCLUSIONS.includes(c.conclusion))
        return { state: "blocked", reason: `check "${c.name}" ${String(c.conclusion).toLowerCase()}` };
    } else if (c.__typename === "StatusContext") {
      if (exclude.includes(c.context)) continue;
      if (respectRequiredOnly && !c.isRequired) continue;
      if (c.state === "PENDING" || c.state === "EXPECTED") pending = true;
      else if (c.state === "ERROR" || c.state === "FAILURE")
        return { state: "blocked", reason: `status "${c.context}" ${c.state.toLowerCase()}` };
    }
  }

  return pending
    ? { state: "pending", reason: "checks still running" }
    : { state: "ready", reason: "mergeable" };
}

export { evaluateReadiness };
