import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./constants.js";
import { runMigrations } from "./migrations/index.js";

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(DB_PATH);

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
runMigrations(db);
