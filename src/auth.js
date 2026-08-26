import { getOctokit } from "@actions/github";
import { createAppAuth } from "@octokit/auth-app";

// Derives an installation token from the GitHub App credentials.
// Returns both an authenticated Octokit and the raw token (needed for git push).
async function authenticate(appId, privateKey, owner, repo) {
  const auth = createAppAuth({ appId, privateKey });

  const app = await auth({ type: "app" });
  const appOctokit = getOctokit(app.token);
  const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
    owner,
    repo,
  });

  const installationAuth = await auth({
    type: "installation",
    installationId: installation.id,
  });

  return {
    octokit: getOctokit(installationAuth.token),
    token: installationAuth.token,
  };
}

export { authenticate };
