import { test } from "node:test";
import assert from "node:assert/strict";
import { syncAll } from "../src/gate.js";

// A PR's readiness is derived by evaluateReadiness from a GraphQL payload; these
// builders produce the minimal payload that yields each state.
const base = () => ({
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
});

function payloadFor(state) {
  if (state === "blocked") return { ...base(), mergeable: "CONFLICTING" };
  if (state === "pending")
    return {
      ...base(),
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null, isRequired: true }],
                },
              },
            },
          },
        ],
      },
    };
  return base(); // ready
}

// Backport PR objects, head.ref must match the `backport-<original>-to-` prefix.
const bp = (number, ref) => ({
  number,
  head: { ref: `backport-1-to-${ref}`, sha: `sha-${number}` },
  base: { ref },
  node_id: `node-${number}`,
});

function fakeOctokit({ backports, readiness }) {
  const posted = [];
  const octokit = {
    posted,
    paginate: async () => backports,
    graphql: async (_q, vars) => ({ repository: { pullRequest: payloadFor(readiness[vars.number]) } }),
    rest: {
      pulls: { list: () => {} },
      checks: {
        listForRef: async () => ({ data: { total_count: 0, check_runs: [] } }),
        create: async (p) => posted.push(p),
        update: async (p) => posted.push(p),
      },
    },
  };
  return octokit;
}

async function run({ original, backports = [], readiness = {} }) {
  const octokit = fakeOctokit({ backports, readiness });
  await syncAll({
    octokit,
    owner: "o",
    repo: "r",
    original,
    checkName: "backports-ready",
    reverseCheckName: "original-ready",
    autoMerge: false,
    autoMergeMethod: "merge",
    respectRequiredOnly: false,
    requireConversationResolution: true,
  });
  return octokit.posted;
}

const byName = (posted, name) => posted.filter((p) => p.name === name);
const original = (merged = false) => ({ number: 1, head: { sha: "orig" }, merged });

test("no backports → backports-ready is an immediate success", async () => {
  const posted = await run({ original: original(), backports: [], readiness: {} });
  const fwd = byName(posted, "backports-ready");
  assert.equal(fwd.length, 1);
  assert.equal(fwd[0].head_sha, "orig");
  assert.equal(fwd[0].conclusion, "success");
});

test("all backports ready → forward success, original-ready on each backport", async () => {
  const backports = [bp(10, "release/v1.x"), bp(11, "release/v2.x")];
  const posted = await run({ original: original(), backports, readiness: { 1: "ready", 10: "ready", 11: "ready" } });

  assert.equal(byName(posted, "backports-ready")[0].conclusion, "success");
  const rev = byName(posted, "original-ready");
  assert.deepEqual(rev.map((p) => p.head_sha).sort(), ["sha-10", "sha-11"]);
  rev.forEach((p) => assert.equal(p.conclusion, "success"));
});

test("any backport blocked → forward failure", async () => {
  const backports = [bp(10, "release/v1.x"), bp(11, "release/v2.x")];
  const posted = await run({ original: original(), backports, readiness: { 1: "ready", 10: "blocked", 11: "ready" } });
  assert.equal(byName(posted, "backports-ready")[0].conclusion, "failure");
});

test("a backport pending (none blocked) → forward in_progress", async () => {
  const backports = [bp(10, "release/v1.x"), bp(11, "release/v2.x")];
  const posted = await run({ original: original(), backports, readiness: { 1: "ready", 10: "pending", 11: "ready" } });
  const fwd = byName(posted, "backports-ready")[0];
  assert.equal(fwd.status, "in_progress");
  assert.equal(fwd.conclusion, undefined);
});

test("original blocked → original-ready fails on each backport", async () => {
  const backports = [bp(10, "release/v1.x"), bp(11, "release/v2.x")];
  const posted = await run({ original: original(), backports, readiness: { 1: "blocked", 10: "ready", 11: "ready" } });
  byName(posted, "original-ready").forEach((p) => assert.equal(p.conclusion, "failure"));
  // Backports themselves are ready, so the forward gate is green.
  assert.equal(byName(posted, "backports-ready")[0].conclusion, "success");
});

test("merged original → original-ready succeeds without evaluating the original", async () => {
  const backports = [bp(10, "release/v1.x")];
  // No readiness entry for #1: a merged original must not be evaluated.
  const posted = await run({ original: original(true), backports, readiness: { 10: "ready" } });
  assert.equal(byName(posted, "original-ready")[0].conclusion, "success");
});
