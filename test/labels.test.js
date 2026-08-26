import { test } from "node:test";
import assert from "node:assert/strict";
import { labelForBranch, desiredBranchesFromLabels } from "../src/labels.js";

const lbl = (name) => ({ name });

test("labelForBranch joins prefix and branch", () => {
  assert.equal(labelForBranch("backport:", "release/v2.x"), "backport:release/v2.x");
});

test("desiredBranchesFromLabels keeps only allowed backport labels", () => {
  const labels = [lbl("backport:release/v2.x"), lbl("bug"), lbl("backport:release/v9.x")];
  const allowed = ["release/v2.x", "release/v1.x"];
  assert.deepEqual(desiredBranchesFromLabels(labels, "backport:", allowed), ["release/v2.x"]);
});

test("desiredBranchesFromLabels ignores non-prefixed labels", () => {
  const labels = [lbl("enhancement"), lbl("release/v2.x")];
  assert.deepEqual(desiredBranchesFromLabels(labels, "backport:", ["release/v2.x"]), []);
});

test("desiredBranchesFromLabels de-duplicates", () => {
  const labels = [lbl("backport:release/v2.x"), lbl("backport:release/v2.x")];
  assert.deepEqual(desiredBranchesFromLabels(labels, "backport:", ["release/v2.x"]), ["release/v2.x"]);
});

test("desiredBranchesFromLabels handles missing labels", () => {
  assert.deepEqual(desiredBranchesFromLabels(null, "backport:", ["release/v2.x"]), []);
  assert.deepEqual(desiredBranchesFromLabels([], "backport:", ["release/v2.x"]), []);
});

test("desiredBranchesFromLabels respects a custom prefix", () => {
  const labels = [lbl("bp/release/v2.x"), lbl("backport:release/v2.x")];
  assert.deepEqual(desiredBranchesFromLabels(labels, "bp/", ["release/v2.x"]), ["release/v2.x"]);
});
