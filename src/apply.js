import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SetupError } from "./errors.js";
import {
  assertDestinationContained,
  assertResolvedParentInside,
  assertSourceAncestorsContained,
  isInside,
  resolveRel,
  writeRegularFile,
} from "./paths.js";

/**
 * @param {ReturnType<import("./plan.js").planSetup>} plan
 * @param {{ dryRun?: boolean, env?: NodeJS.ProcessEnv, stdio?: import("node:child_process").StdioOptions }} [options]
 */
export function applyPlan(plan, { dryRun = false, env = process.env, stdio = "inherit" } = {}) {
  if (dryRun) return { ok: true, dryRun: true, executed: [] };
  /** @type {Array<{ type: string, rel?: string, command?: string, action?: string }>} */
  const executed = [];
  for (const item of plan.copies) {
    if (item.action !== "copy" && item.action !== "overwrite") continue;
    copyFile(plan.source, plan.workspace, item.rel);
    executed.push({ type: "copy", rel: item.rel, action: item.action });
  }
  for (const action of plan.trust) {
    if (action.action !== "run") continue;
    if (!commandExists(action.tool, env)) {
      throw new SetupError(
        `${action.tool} is not on PATH (${action.config} is present). Install ${action.tool}, or re-run with --skip-trust.`,
      );
    }
    const commandEnv = action.tool === "mise" ? { ...env, MISE_YES: "1" } : env;
    const code = runShell(action.command, { cwd: plan.workspace, env: commandEnv, stdio });
    if (code !== 0) {
      throw new SetupError(`${action.command} failed (exit ${code})`);
    }
    executed.push({ type: "trust", command: action.command });
  }
  if (!plan.install.skipped) {
    for (const command of plan.install.commands) {
      const code = runShell(command, { cwd: plan.workspace, env, stdio });
      if (code !== 0) {
        throw new SetupError(`install failed (exit ${code}): ${command}`);
      }
      executed.push({ type: "install", command });
    }
  }
  return { ok: true, dryRun: false, executed };
}

/**
 * Copy one file. The destination directory entry is replaced with a new
 * regular file, so a symlink is not followed and a hard link does not
 * update any other name. A parent symlink that resolves outside the
 * workspace is refused before any directory is created or any byte is written.
 * @param {string} source
 * @param {string} workspace
 * @param {string} rel
 */
export function copyFile(source, workspace, rel) {
  const src = resolveRel(source, rel);
  const dest = resolveRel(workspace, rel);
  if (!isInside(source, src) || !isInside(workspace, dest)) {
    throw new SetupError(`refusing to write outside the workspace: ${rel}`);
  }
  assertSourceAncestorsContained(source, rel);
  assertDestinationContained(workspace, rel);
  let mode;
  try {
    mode = fs.statSync(src).mode & 0o777;
  } catch (err) {
    throw new SetupError(`failed to copy ${rel}: ${messageOf(err)}`);
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    throw new SetupError(`failed to copy ${rel}: ${messageOf(err)}`);
  }
  assertResolvedParentInside(workspace, rel);
  let current = null;
  try {
    current = fs.lstatSync(dest);
  } catch (err) {
    if (!isMissing(err)) throw new SetupError(`failed to copy ${rel}: ${messageOf(err)}`);
  }
  if (current?.isDirectory()) {
    throw new SetupError(`${rel} exists as a directory in the workspace`);
  }
  try {
    writeRegularFile(dest, fs.readFileSync(src), mode);
  } catch (err) {
    if (err instanceof SetupError) throw err;
    throw new SetupError(`failed to copy ${rel}: ${messageOf(err)}`);
  }
}

/**
 * @param {unknown} err
 */
function isMissing(err) {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "ENOENT" || err.code === "ENOTDIR")
  );
}

/**
 * @param {unknown} err
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {string} command
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, stdio?: import("node:child_process").StdioOptions }} options
 */
export function runShell(command, { cwd, env, stdio = "inherit" }) {
  const result = spawnSync(command, { cwd, env, shell: true, stdio });
  if (result.error) {
    throw new SetupError(`failed to run ${command}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 */
export function commandExists(name, env) {
  const entries = (env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  for (const dir of entries) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}
