import * as core from "@actions/core";

function readConfig() {
  return {
    appId: core.getInput("app-id", { required: true }),
    privateKey: core.getInput("private-key", { required: true }),
    allowedBranches: core
      .getMultilineInput("backport-branches", { required: true })
      .map((b) => b.trim())
      .filter(Boolean),
    checkName: core.getInput("check-name") || "backports-ready",
    reverseCheckName: core.getInput("reverse-check-name") || "original-ready",
    cherryPicking: core.getInput("cherry-picking") || "auto",
    labelPrefix: core.getInput("label-prefix") || "backport:",
    deleteOnRemoval: core.getBooleanInput("delete-on-removal"),
    closeBackportsOnAbandon: core.getBooleanInput("close-backports-on-abandon"),
    autoMerge: core.getBooleanInput("auto-merge"),
    autoMergeMethod: core.getInput("auto-merge-method") || "merge",
    respectRequiredOnly: core.getBooleanInput("respect-required-only"),
    requireConversationResolution: core.getBooleanInput("require-conversation-resolution"),
    metadata: {
      copyLabels: core.getBooleanInput("copy-labels"),
      copyMilestone: core.getBooleanInput("copy-milestone"),
      copyAssignees: core.getBooleanInput("copy-assignees"),
      copyReviewers: core.getBooleanInput("copy-reviewers"),
    },
    committer: {
      name: core.getInput("committer-name") || "github-actions[bot]",
      email:
        core.getInput("committer-email") ||
        `github-actions[bot]@users.noreply.${
          new URL(process.env.GITHUB_SERVER_URL || "https://github.com").host
        }`,
    },
    signing: {
      gpgPrivateKey: core.getInput("gpg-private-key"),
      gpgPassphrase: core.getInput("gpg-passphrase"),
      sshSigningKey: core.getInput("ssh-signing-key"),
    },
  };
}

export { readConfig };
