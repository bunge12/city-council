// Sets this clone's git comment character to `;` (issue #234). Runs from
// `pnpm install` as the root `prepare` script.
//
// Commit subjects here start with the issue number, `#204: ...`. While git
// edits a message, during `rebase --continue`, `commit --amend` or a squash,
// it drops every line that starts with the comment character, `#` by
// default. A subject that starts with `#` goes with it, and the commit
// aborts on an empty message. With `;` the subject survives.
//
// It changes the clone's own .git/config, never the user's global config,
// and does nothing outside a git checkout. A failure only prints: an
// install must not fail over this.

import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

try {
  if (git("rev-parse", "--is-inside-work-tree") === "true" && git("config", "--local", "--default", "", "--get", "core.commentChar") !== ";") {
    git("config", "--local", "core.commentChar", ";");
    console.log("git-setup: set core.commentChar to ; so #NNN: commit subjects survive a rebase");
  }
} catch {
  // Not a git checkout, no git, or a checkout git will not touch (a
  // container that owns it as another user). Nothing to set.
}
