import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cherryPickOntoBranch } from "../src/git.js";

// These tests exercise the real git CLI against a disposable local repo built
// per test (bare "origin" + a work clone). No network, no persistent repo.

const sh = (cwd, args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

function gcfg(dir) {
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "commit.gpgsign", "false"]); // ignore any global signing config
}

// Creates root/origin.git (bare) + root/src with a base commit on main pushed.
function scaffold() {
  const root = mkdtempSync(path.join(tmpdir(), "bp-git-"));
  const origin = path.join(root, "origin.git");
  const src = path.join(root, "src");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", src], { stdio: "pipe" });
  gcfg(src);
  writeFileSync(path.join(src, "base.txt"), "base\n");
  sh(src, ["add", "."]);
  sh(src, ["commit", "-m", "base"]);
  sh(src, ["remote", "add", "origin", origin]);
  sh(src, ["push", "origin", "main"]);
  return { root, origin, src };
}

// Creates release/v2.x from main (optionally with extra committed files) and pushes it.
function makeRelease(src, origin, files = []) {
  sh(src, ["checkout", "-B", "release/v2.x", "main"]);
  for (const f of files) writeFileSync(path.join(src, f.name), f.content);
  if (files.length) {
    sh(src, ["add", "."]);
    sh(src, ["commit", "-m", "release change"]);
  }
  sh(src, ["push", "-f", "origin", "release/v2.x"]);
  sh(src, ["checkout", "main"]);
}

// Pushes a PR branch (off main) to origin as refs/pull/<n>/head.
function makePR(src, origin, n, commits) {
  sh(src, ["checkout", "-B", `pr${n}`, "main"]);
  for (const c of commits) {
    for (const f of c.files) writeFileSync(path.join(src, f.name), f.content);
    sh(src, ["add", "."]);
    sh(src, ["commit", "-m", c.msg]);
  }
  sh(src, ["push", "-f", origin, `pr${n}:refs/pull/${n}/head`]);
  sh(src, ["checkout", "main"]);
}

function cloneWork(root, origin) {
  const work = path.join(root, "work");
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  gcfg(work);
  return work;
}

async function runCherry(work, opts) {
  const prev = process.cwd();
  process.chdir(work);
  try {
    return await cherryPickOntoBranch(opts);
  } finally {
    process.chdir(prev);
  }
}

test("individual: cleanly cherry-picks the PR commit with -x provenance", async () => {
  const { root, origin, src } = scaffold();
  try {
    makeRelease(src, origin);
    makePR(src, origin, 42, [{ files: [{ name: "feature.txt", content: "hello\n" }], msg: "add feature" }]);
    const work = cloneWork(root, origin);

    const res = await runCherry(work, {
      target: "release/v2.x",
      baseRef: "main",
      prNumber: 42,
      branch: "backport-42-to-release/v2.x",
      squash: false,
      message: "unused",
    });

    assert.equal(res.conflict, false);
    assert.equal(readFileSync(path.join(work, "feature.txt"), "utf8"), "hello\n");
    assert.match(sh(work, ["log", "-1", "--format=%B"]), /cherry picked from commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflict: commits the markers in place and reports the conflict", async () => {
  const { root, origin, src } = scaffold();
  try {
    makeRelease(src, origin, [{ name: "feature.txt", content: "RELEASE\n" }]);
    makePR(src, origin, 43, [{ files: [{ name: "feature.txt", content: "MAIN\n" }], msg: "add feature main" }]);
    const work = cloneWork(root, origin);

    const res = await runCherry(work, {
      target: "release/v2.x",
      baseRef: "main",
      prNumber: 43,
      branch: "backport-43-to-release/v2.x",
      squash: false,
      message: "unused",
    });

    assert.equal(res.conflict, true);
    assert.match(readFileSync(path.join(work, "feature.txt"), "utf8"), /<<<<<<</);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("squash: collapses the PR's commits into one with the given message", async () => {
  const { root, origin, src } = scaffold();
  try {
    makeRelease(src, origin);
    makePR(src, origin, 44, [
      { files: [{ name: "a.txt", content: "a\n" }], msg: "c1" },
      { files: [{ name: "b.txt", content: "b\n" }], msg: "c2" },
    ]);
    const work = cloneWork(root, origin);

    const res = await runCherry(work, {
      target: "release/v2.x",
      baseRef: "main",
      prNumber: 44,
      branch: "backport-44-to-release/v2.x",
      squash: true,
      message: "squashed backport",
    });

    assert.equal(res.conflict, false);
    assert.equal(sh(work, ["rev-list", "--count", "origin/release/v2.x..HEAD"]).trim(), "1");
    assert.equal(sh(work, ["log", "-1", "--format=%s"]).trim(), "squashed backport");
    assert.equal(readFileSync(path.join(work, "a.txt"), "utf8"), "a\n");
    assert.equal(readFileSync(path.join(work, "b.txt"), "utf8"), "b\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
