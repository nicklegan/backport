// Backport branch naming and the mapping back to the original PR.
// Naming: backport-<pr_number>-to-<target_branch>
const PREFIX = "backport-";

function branchName(prNumber, target) {
  return `${PREFIX}${prNumber}-to-${target}`;
}

function branchPrefixFor(prNumber) {
  return `${PREFIX}${prNumber}-to-`;
}

// Extracts the original PR number from a backport branch ref, or null.
function originalPrNumberFromBranch(ref) {
  const match = /^backport-(\d+)-to-.+$/.exec(ref || "");
  return match ? Number(match[1]) : null;
}

export { branchName, branchPrefixFor, originalPrNumberFromBranch };
