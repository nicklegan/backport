import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReadiness } from "../src/readiness.js";

const GATE = ["backports-ready", "original-ready"];

const checkRun = (name, conclusion, opts = {}) => ({
  __typename: "CheckRun",
  name,
  status: opts.status || "COMPLETED",
  conclusion,
  isRequired: opts.isRequired !== false,
});

const statusContext = (context, state, opts = {}) => ({
  __typename: "StatusContext",
  context,
  state,
  isRequired: opts.isRequired !== false,
});

function makePR(overrides = {}) {
  const { contexts = [], ...rest } = overrides;
  return {
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
    ...rest,
  };
}

const fakeOctokit = (pr) => ({ graphql: async () => ({ repository: { pullRequest: pr } }) });

async function evaluate(pr, { exclude = GATE, respectRequiredOnly = false, requireConversationResolution = true } = {}) {
  return evaluateReadiness({
    octokit: fakeOctokit(pr),
    owner: "o",
    repo: "r",
    number: 1,
    exclude,
    respectRequiredOnly,
    requireConversationResolution,
  });
}

test("ready when clean, approved, and all checks pass", async () => {
  const pr = makePR({ contexts: [checkRun("test", "SUCCESS")] });
  assert.equal((await evaluate(pr)).state, "ready");
});

test("blocked when draft", async () => {
  assert.equal((await evaluate(makePR({ isDraft: true }))).state, "blocked");
});

test("blocked on merge conflicts", async () => {
  assert.equal((await evaluate(makePR({ mergeable: "CONFLICTING" }))).state, "blocked");
});

test("blocked when changes requested", async () => {
  assert.equal((await evaluate(makePR({ reviewDecision: "CHANGES_REQUESTED" }))).state, "blocked");
});

test("blocked when a review is required", async () => {
  assert.equal((await evaluate(makePR({ reviewDecision: "REVIEW_REQUIRED" }))).state, "blocked");
});

test("blocked on an unresolved conversation", async () => {
  const pr = makePR({ reviewThreads: { nodes: [{ isResolved: false }] } });
  assert.equal((await evaluate(pr)).state, "blocked");
});

test("blocked on a failing check", async () => {
  const pr = makePR({ contexts: [checkRun("test", "FAILURE")] });
  const r = await evaluate(pr);
  assert.equal(r.state, "blocked");
  assert.match(r.reason, /test/);
});

test("blocked on a failing status context", async () => {
  const pr = makePR({ contexts: [statusContext("ci/legacy", "FAILURE")] });
  assert.equal((await evaluate(pr)).state, "blocked");
});

test("pending while a check is still running", async () => {
  const pr = makePR({ contexts: [checkRun("test", null, { status: "IN_PROGRESS" })] });
  assert.equal((await evaluate(pr)).state, "pending");
});

test("the two gate checks are always excluded", async () => {
  const pr = makePR({ contexts: [checkRun("backports-ready", "FAILURE"), checkRun("original-ready", "FAILURE")] });
  assert.equal((await evaluate(pr)).state, "ready");
});

test("NEUTRAL and SKIPPED conclusions count as ok", async () => {
  const pr = makePR({ contexts: [checkRun("a", "NEUTRAL"), checkRun("b", "SKIPPED")] });
  assert.equal((await evaluate(pr)).state, "ready");
});

test("respectRequiredOnly ignores a failing advisory check", async () => {
  const pr = makePR({ contexts: [checkRun("advisory", "FAILURE", { isRequired: false })] });
  assert.equal((await evaluate(pr, { respectRequiredOnly: true })).state, "ready");
  assert.equal((await evaluate(pr, { respectRequiredOnly: false })).state, "blocked");
});

test("respectRequiredOnly still blocks on a failing required check", async () => {
  const pr = makePR({ contexts: [checkRun("required", "FAILURE", { isRequired: true })] });
  assert.equal((await evaluate(pr, { respectRequiredOnly: true })).state, "blocked");
});

test("requireConversationResolution:false ignores unresolved threads", async () => {
  const pr = makePR({ reviewThreads: { nodes: [{ isResolved: false }] } });
  assert.equal((await evaluate(pr, { requireConversationResolution: false })).state, "ready");
});
