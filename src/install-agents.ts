import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const START_MARKER = "<!-- MEMORY_MCP_SERVER_START -->";
const END_MARKER = "<!-- MEMORY_MCP_SERVER_END -->";

export interface InstallTarget {
  name: string;
  path: string;
}

function targets(): InstallTarget[] {
  return [
    { name: "Claude Code", path: join(homedir(), ".claude", "CLAUDE.md") },
    { name: "Codex CLI", path: join(homedir(), ".codex", "AGENTS.md") },
  ];
}

/** Extracts the pasteable snippet (markers inclusive) from README.md content. */
export function extractSnippet(readmeContent: string): string {
  const start = readmeContent.indexOf(START_MARKER);
  const end = readmeContent.indexOf(END_MARKER);
  if (start === -1 || end === -1) {
    throw new Error(
      `Could not find ${START_MARKER} / ${END_MARKER} markers in README.md`
    );
  }
  return readmeContent.slice(start, end + END_MARKER.length).trim();
}

export type InstallAction = "created" | "appended" | "updated";

/**
 * Pure decision of the next file content, given the current content
 * (null when the file does not exist yet) and the snippet to install.
 * No filesystem access, so this is directly unit-testable.
 */
export function computeInstall(
  existingContent: string | null,
  snippet: string
): { content: string; action: InstallAction } {
  if (existingContent === null) {
    return { content: `${snippet}\n`, action: "created" };
  }

  const start = existingContent.indexOf(START_MARKER);
  const end = existingContent.indexOf(END_MARKER);
  if (start !== -1 && end !== -1) {
    return {
      content:
        existingContent.slice(0, start) +
        snippet +
        existingContent.slice(end + END_MARKER.length),
      action: "updated",
    };
  }

  const separator = existingContent.trim().length ? "\n\n" : "";
  return {
    content: `${existingContent}${separator}${snippet}\n`,
    action: "appended",
  };
}

/**
 * Installs the README's Memory MCP Server snippet into the global config
 * files of commonly-used agents (Claude Code, Codex CLI). Idempotent, and
 * never touches project-scoped files.
 *
 * `overrides` exists so tests can point at a temp dir instead of the real
 * home directory; production callers pass nothing.
 */
export async function installAgents(
  overrides: { targets?: InstallTarget[]; readmePath?: string } = {}
): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const readmePath = overrides.readmePath ?? join(packageRoot, "README.md");
  const readmeContent = readFileSync(readmePath, "utf8");
  const snippet = extractSnippet(readmeContent);

  for (const target of overrides.targets ?? targets()) {
    const exists = existsSync(target.path);
    if (exists) {
      copyFileSync(target.path, `${target.path}.bak`);
    } else {
      mkdirSync(dirname(target.path), { recursive: true });
    }

    const existingContent = exists ? readFileSync(target.path, "utf8") : null;
    const { content, action } = computeInstall(existingContent, snippet);
    writeFileSync(target.path, content);
    console.log(`[${action}] ${target.name} -> ${target.path}`);
  }
}
