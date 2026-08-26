// Parses the mandatory PR template's task list. Each candidate branch is a
// task-list item using its literal branch name, e.g. "- [x] release/v2.x".
// A checked box selects that branch.
const TASK_ITEM = /^\s*-\s*\[([ xX])\]\s+(\S.*?)\s*$/gm;

// The template's checkbox block, delimited so it can be removed reliably.
const TARGET_BLOCK =
  /\n?<!--\s*backport-targets:start\s*-->[\s\S]*?<!--\s*backport-targets:end\s*-->\n?/;

function parseSelectedBranches(body) {
  const selected = [];
  if (!body) return selected;

  let match;
  while ((match = TASK_ITEM.exec(body)) !== null) {
    const checked = match[1].toLowerCase() === "x";
    if (checked) selected.push(match[2].trim());
  }
  return selected;
}

// Removes the checkbox block once its selection has been seeded into labels, so
// labels become the single place to manage backports. No-op without the block.
function stripTargetBlock(body) {
  if (!body) return body;
  return body.replace(
    TARGET_BLOCK,
    "\n\n_Backport targets are managed via `backport:*` labels._\n",
  );
}

export { parseSelectedBranches, stripTargetBlock };
