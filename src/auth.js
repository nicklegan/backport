import { getOctokit } from "@actions/github";
import { createAppAuth } from "@octokit/auth-app";

// Derives an installation token from the GitHub App credentials.
// Returns both an authenticated Octokit and the raw token (needed for git push).
// All calls ride the runner-provided API/GraphQL base URLs so the action works
// on github.com, ghe.com, and GHES without per-platform branching.
async function authenticate(appId, privateKey, owner, repo) {
  const apiUrl = process.env.GITHUB_API_URL;
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL;
  const octokitOptions = apiUrl ? { baseUrl: apiUrl } : {};

  const auth = createAppAuth({ appId, privateKey });

  // The app JWT is generated locally; minting the installation token via REST on
  // appOctokit keeps it on the tenant host (auth-app's installation flow would
  // otherwise POST to api.github.com).
  const app = await auth({ type: "app" });
  const appOctokit = getOctokit(app.token, octokitOptions);
  const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
    owner,
    repo,
  });
  const { data: token } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: installation.id,
  });

  const octokit = getOctokit(token.token, octokitOptions);
  if (graphqlUrl) {
    // Octokit appends "/graphql" to the graphql baseUrl, so strip it here to land
    // on the right path (GHES uses /api/graphql, not the REST /api/v3 root).
    octokit.graphql = octokit.graphql.defaults({
      baseUrl: graphqlUrl.replace(/\/graphql$/, ""),
    });
  }

  return { octokit, token: token.token };
}

export { authenticate };
