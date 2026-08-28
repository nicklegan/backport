// backport:<branch> label naming — labels are the source of truth for which
// branches a PR is backported to.
function labelForBranch(prefix, branch) {
  return `${prefix}${branch}`;
}

function branchFromLabel(prefix, label) {
  return label.startsWith(prefix) ? label.slice(prefix.length) : null;
}

// Branches selected via backport:<branch> labels, limited to the allowed set.
function desiredBranchesFromLabels(labels, prefix, allowed) {
  const branches = (labels || [])
    .map((l) => branchFromLabel(prefix, l.name))
    .filter((b) => b && allowed.includes(b));
  return [...new Set(branches)];
}

export { labelForBranch, desiredBranchesFromLabels };
