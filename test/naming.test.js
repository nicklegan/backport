import { test } from "node:test";
import assert from "node:assert/strict";
import { branchName, branchPrefixFor, originalPrNumberFromBranch } from "../src/naming.js";

test("branchName builds the canonical backport branch", () => {
  assert.equal(branchName(123, "release/v2.x"), "backport-123-to-release/v2.x");
});

test("branchPrefixFor returns the per-PR branch prefix", () => {
  assert.equal(branchPrefixFor(123), "backport-123-to-");
});

test("branchName and branchPrefixFor are consistent", () => {
  const name = branchName(7, "release/v1.x");
  assert.ok(name.startsWith(branchPrefixFor(7)));
});

test("originalPrNumberFromBranch extracts the PR number", () => {
  assert.equal(originalPrNumberFromBranch("backport-123-to-release/v2.x"), 123);
});

test("originalPrNumberFromBranch returns null for non-backport refs", () => {
  assert.equal(originalPrNumberFromBranch("feature/thing"), null);
  assert.equal(originalPrNumberFromBranch("backport-abc-to-main"), null);
  assert.equal(originalPrNumberFromBranch(""), null);
  assert.equal(originalPrNumberFromBranch(null), null);
});

test("round trips branch name back to PR number", () => {
  const ref = branchName(42, "release/v9.x");
  assert.equal(originalPrNumberFromBranch(ref), 42);
});
