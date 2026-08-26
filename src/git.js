import { exec, getExecOutput } from "@actions/exec";
import { configureSigning } from "./signing.js";

async function git(args, options = {}) {
  await exec("git", args, options);
}

async function gitOut(args) {
  const res = await getExecOutput("git", args, { silent: true });
  return res.stdout.trim();
}

async function gitTry(args) {
  const res = await exec("git", args, { ignoreReturnCode: true });
  return res;
}

// One-time repo setup before cherry-picking: committer identity, App-token push
// credential, and optional commit signing. Called once per run.
async function configureRepo({ core, token, owner, repo, committer, signing }) {
  core.setSecret(token);
  const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  await git(["config", "user.name", committer.name]);
  await git(["config", "user.email", committer.email]);
  await git(["remote", "set-url", "origin", remote]);

  // actions/checkout persists the workflow token's credential so it would win
  // over our App-token remote URL on push. Older versions use an inline
  // `http.<url>.extraheader`; newer ones pull it from a file via
  // `includeIf.gitdir`. Remove both so the App-token remote URL authenticates.
  const localKeys = await getExecOutput(
    "git",
    ["config", "--local", "--name-only", "--list"],
    { silent: true, ignoreReturnCode: true },
  );
  for (const key of localKeys.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (key.startsWith("includeif.") || key.endsWith(".extraheader")) {
      await gitTry(["config", "--local", "--unset-all", key]);
    }
  }

  if (await configureSigning(core, signing)) {
    core.info("Commit signing enabled for cherry-picks.");
  }
}

// Cherry-picks the original PR's own commits onto the target branch and
// force-pushes the backport branch. Returns whether a conflict was recorded.
// On conflict, the conflict markers are committed in place so the backport PR
// can still be opened; its checks stay red until a human resolves them.
//
// `squash` collapses the PR's own commits into a single commit (built off the
// PR's merge base, so only the PR's changes are included) to match a
// squash-merge; otherwise each PR commit is replayed with `-x`.
async function resolveCommits({ baseRef, prNumber, squash, message }) {
  if (!squash) {
    const list = await gitOut([
      "rev-list",
      "--reverse",
      "--no-merges",
      `origin/${baseRef}..origin/pr-${prNumber}`,
    ]);
    return { commits: list.split("\n").filter(Boolean), keepSourceRef: true };
  }

  const prBase = await gitOut(["merge-base", `origin/${baseRef}`, `origin/pr-${prNumber}`]);
  await git(["checkout", "-B", "__backport_squash", prBase]);
  await gitTry(["merge", "--squash", `origin/pr-${prNumber}`]);
  await git(["add", "-A"]);
  await git(["commit", "--no-verify", "--allow-empty", "-m", message]);
  const squashSha = await gitOut(["rev-parse", "HEAD"]);
  return { commits: [squashSha], keepSourceRef: false };
}

async function cherryPickOntoBranch({ target, baseRef, prNumber, branch, squash, message }) {
  await git([
    "fetch",
    "--force",
    "origin",
    `${baseRef}:refs/remotes/origin/${baseRef}`,
    `refs/pull/${prNumber}/head:refs/remotes/origin/pr-${prNumber}`,
    `${target}:refs/remotes/origin/${target}`,
  ]);

  const { commits, keepSourceRef } = await resolveCommits({ baseRef, prNumber, squash, message });

  // Reset the backport branch to the target tip so re-runs re-cherry-pick cleanly.
  await git(["checkout", "-B", branch, `origin/${target}`]);

  let conflict = false;
  for (const sha of commits) {
    const code = await gitTry(keepSourceRef ? ["cherry-pick", "-x", sha] : ["cherry-pick", sha]);
    if (code !== 0) {
      // Empty (already applied on target) leaves a clean tree — skip it.
      // A real conflict leaves unmerged paths — commit the markers in place.
      const dirty = await gitOut(["status", "--porcelain"]);
      if (dirty === "") {
        await gitTry(["cherry-pick", "--skip"]);
      } else {
        conflict = true;
        await git(["add", "-A"]);
        await git(["commit", "--no-edit", "--no-verify"]);
      }
    }
  }

  await git(["push", "--force", "origin", branch]);
  return { conflict };
}

export { configureRepo, cherryPickOntoBranch };
