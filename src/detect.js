import fs from "node:fs";
import path from "node:path";

/**
 * First existing lockfile wins. package-lock.json is last so it does not
 * hide a pnpm, bun, or yarn lockfile in the same tree.
 */
export const LOCKFILES = [
  {
    file: "pnpm-lock.yaml",
    manager: "pnpm",
    command: "pnpm install --frozen-lockfile",
  },
  {
    file: "bun.lock",
    manager: "bun",
    command: "bun install --frozen-lockfile",
  },
  {
    file: "bun.lockb",
    manager: "bun",
    command: "bun install --frozen-lockfile",
  },
  {
    file: "yarn.lock",
    manager: "yarn",
    command: "yarn install --frozen-lockfile",
  },
  {
    file: "package-lock.json",
    manager: "npm",
    command: "npm ci",
  },
];

/**
 * @param {string} workspace
 * @returns {{ manager: string | null, lockfile: string | null, commands: string[] }}
 */
export function detectInstall(workspace) {
  for (const entry of LOCKFILES) {
    if (fs.existsSync(path.join(workspace, entry.file))) {
      return {
        manager: entry.manager,
        lockfile: entry.file,
        commands: [entry.command],
      };
    }
  }
  return { manager: null, lockfile: null, commands: [] };
}
