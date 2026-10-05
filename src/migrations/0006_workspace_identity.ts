import os from "node:os";
import type { Migration } from "./index.js";

export const migration0006WorkspaceIdentity: Migration = {
  version: "0006_workspace_identity",
  apply(db) {
    db.exec(`ALTER TABLE reasoning_sessions ADD COLUMN workspace TEXT;`);
    // '/' and the home directory never identified a project; they were the
    // server's cwd when a desktop app launched it. NULL = unknown origin.
    db.prepare(
      `UPDATE memories SET workspace = NULL WHERE workspace = '/' OR workspace = ?`
    ).run(os.homedir());
  },
};
