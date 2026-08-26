import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSelectedBranches, stripTargetBlock } from "../src/template.js";

test("parseSelectedBranches returns only checked branches", () => {
  const body = "## Backport targets\n- [x] release/v2.x\n- [ ] release/v1.x";
  assert.deepEqual(parseSelectedBranches(body), ["release/v2.x"]);
});

test("parseSelectedBranches accepts uppercase [X]", () => {
  assert.deepEqual(parseSelectedBranches("- [X] release/v3.x"), ["release/v3.x"]);
});

test("parseSelectedBranches preserves slashes in branch names", () => {
  const body = "- [x] release/v2.x\n- [x] hotfix/urgent";
  assert.deepEqual(parseSelectedBranches(body), ["release/v2.x", "hotfix/urgent"]);
});

test("parseSelectedBranches returns [] for empty or missing body", () => {
  assert.deepEqual(parseSelectedBranches(""), []);
  assert.deepEqual(parseSelectedBranches(null), []);
  assert.deepEqual(parseSelectedBranches(undefined), []);
});

test("parseSelectedBranches ignores unchecked-only lists", () => {
  assert.deepEqual(parseSelectedBranches("- [ ] release/v1.x\n- [ ] release/v2.x"), []);
});

test("stripTargetBlock removes the marker block and leaves a note", () => {
  const body = "Intro\n\n<!-- backport-targets:start -->\n- [x] release/v2.x\n<!-- backport-targets:end -->\n\nOutro";
  const out = stripTargetBlock(body);
  assert.ok(!out.includes("backport-targets:start"));
  assert.ok(!out.includes("backport-targets:end"));
  assert.ok(out.includes("managed via `backport:*` labels"));
  assert.ok(out.startsWith("Intro"));
  assert.ok(out.includes("Outro"));
});

test("stripTargetBlock is a no-op without the marker block", () => {
  const body = "No markers here";
  assert.equal(stripTargetBlock(body), body);
});

test("stripTargetBlock handles empty or missing body", () => {
  assert.equal(stripTargetBlock(""), "");
  assert.equal(stripTargetBlock(null), null);
});
