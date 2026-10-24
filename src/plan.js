import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./errors.js";
import { detectInstall } from "./detect.js";
import { assertDestinationContained, isInside, resolveRel } from "./paths.js";

export const MISE_CONFIGS = ["mise.toml", ".mise.toml", ".mise/config.toml", ".tool-versions"];

/**
 * @param {{
 *   workspace: string,
 *   source: string,
 *   config: { copy: string[], install: string[] | null, trust: { direnv: boolean, mise: boolean } },
 *   configPath: string,
 *   origin: "file" | "defaults",
 *   force?: boolean,
 *   skipInstall?: boolean,
 *   skipTrust?: boolean,
 * }} input
 */
export function planSetup({
  workspace,
  source,
  config,
  configPath,
  origin,
  force = false,
  skipInstall = false,
  skipTrust = false,
}) {
  const copies = planCopies({ workspace, source, specs: config.copy, force });
  return {
    workspace,
    source,
    configPath,
    origin,
    copies,
    install: planInstall({ workspace, install: config.install, skipInstall }),
    trust: [
      planDirenv({ workspace, copies, enabled: config.trust.direnv, skipTrust }),
      planMise({ workspace, copies, enabled: config.trust.mise, skipTrust }),
    ],
  };
}

/**
 * @param {{ workspace: string, source: string, specs: string[], force: boolean }} input
 */
function planCopies({ workspace, source, specs, force }) {
  /** @type {Array<{ spec: string, rel: string, action: string, reason: string }>} */
  const copies = [];
  const seen = new Set();
  for (const spec of specs) {
    const files = collectFiles(source, spec);
    if (files === null) {
      if (!seen.has(spec)) {
        copies.push({ spec, rel: spec, action: "absent", reason: "not in source" });
        seen.add(spec);
      }
      continue;
    }
    if (files.length === 0) {
      copies.push({ spec, rel: spec, action: "skip", reason: "empty directory" });
      seen.add(spec);
      continue;
    }
    for (const rel of files) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      copies.push({ spec, ...classifyFile({ workspace, source, rel, force }) });
    }
  }
  return copies;
}

/**
 * File symlinks are copied as regular files, including targets outside the
 * source. Directory symlinks are walked only when the real target stays
 * inside the source. External targets and cycles are refused, and the error
 * keeps the path that was requested instead of expanding the cycle.
 * @param {string} source
 * @param {string} rel
 * @returns {string[] | null}
 */
function collectFiles(source, rel) {
  let sourceReal;
  try {
    sourceReal = fs.realpathSync(source);
  } catch (err) {
    throw new SetupError(`cannot read ${rel}: ${errorMessage(err)}`);
  }
  const opened = openRelative(sourceReal, rel, []);
  if (opened === null) return null;
  if (opened.kind === "file") return [rel];
  const files = [];
  listDirectory(sourceReal, opened.physical, rel, opened.stack, files);
  return files;
}

/**
 * Walk `rel` from the real source root, one component at a time.
 * @param {string} sourceReal
 * @param {string} rel
 * @param {string[]} stack real directories already entered on this walk
 * @returns {{ kind: "file" } | { kind: "directory", physical: string, stack: string[] } | null}
 */
function openRelative(sourceReal, rel, stack) {
  const parts = rel.split("/").filter((part) => part.length > 0);
  let current = sourceReal;
  for (let i = 0; i < parts.length; i++) {
    const relSoFar = parts.slice(0, i + 1).join("/");
    const opened = openChild(sourceReal, current, parts[i], relSoFar, stack);
    if (opened === null) return null;
    if (opened.kind === "file") {
      if (i !== parts.length - 1) {
        throw new SetupError(`cannot read ${rel}: ${relSoFar} is not a directory`);
      }
      return opened;
    }
    current = opened.physical;
  }
  return { kind: "directory", physical: current, stack };
}

/**
 * @param {string} sourceReal
 * @param {string} dirPhysical
 * @param {string} name
 * @param {string} relSoFar
 * @param {string[]} stack
 * @returns {{ kind: "file" } | { kind: "directory", physical: string } | null}
 */
function openChild(sourceReal, dirPhysical, name, relSoFar, stack) {
  const next = path.join(dirPhysical, name);
  let listed;
  try {
    listed = fs.lstatSync(next);
  } catch (err) {
    if (isMissing(err)) return null;
    throw new SetupError(`cannot read ${relSoFar}: ${errorMessage(err)}`);
  }
  if (listed.isSymbolicLink()) return openSymlink(sourceReal, next, relSoFar, stack);
  if (listed.isFile()) return { kind: "file" };
  if (listed.isDirectory()) {
    enterDirectory(next, relSoFar, stack);
    return { kind: "directory", physical: next };
  }
  throw new SetupError(`${relSoFar} is not a file or directory`);
}

/**
 * @param {string} sourceReal
 * @param {string} linkPath
 * @param {string} relSoFar
 * @param {string[]} stack
 * @returns {{ kind: "file" } | { kind: "directory", physical: string } | null}
 */
function openSymlink(sourceReal, linkPath, relSoFar, stack) {
  let target;
  try {
    target = fs.realpathSync(linkPath);
  } catch (err) {
    if (isMissing(err)) return null;
    if (codeOf(err) === "ELOOP") {
      throw new SetupError(`refusing to follow directory symlink cycle: ${relSoFar}`);
    }
    throw new SetupError(`cannot read ${relSoFar}: ${errorMessage(err)}`);
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (isMissing(err)) return null;
    throw new SetupError(`cannot read ${relSoFar}: ${errorMessage(err)}`);
  }
  if (stat.isFile()) return { kind: "file" };
  if (!stat.isDirectory()) {
    throw new SetupError(`${relSoFar} is not a file or directory`);
  }
  if (stack.includes(target)) {
    throw new SetupError(`refusing to follow directory symlink cycle: ${relSoFar}`);
  }
  if (!isInside(sourceReal, target)) {
    throw new SetupError(
      `refusing to follow directory symlink outside the source tree: ${relSoFar} -> ${target}`,
    );
  }
  enterDirectory(target, relSoFar, stack);
  return { kind: "directory", physical: target };
}

/**
 * @param {string} physical
 * @param {string} relSoFar
 * @param {string[]} stack
 */
function enterDirectory(physical, relSoFar, stack) {
  if (stack.includes(physical)) {
    throw new SetupError(`refusing to follow directory symlink cycle: ${relSoFar}`);
  }
  stack.push(physical);
}

/**
 * @param {string} sourceReal
 * @param {string} physical
 * @param {string} rel
 * @param {string[]} stack
 * @param {string[]} files
 */
function listDirectory(sourceReal, physical, rel, stack, files) {
  let names;
  try {
    names = fs.readdirSync(physical);
  } catch (err) {
    throw new SetupError(`cannot read ${rel}: ${errorMessage(err)}`);
  }
  for (const name of names.sort()) {
    const childRel = `${rel}/${name}`;
    const childStack = stack.slice();
    const opened = openChild(sourceReal, physical, name, childRel, childStack);
    if (opened === null) continue;
    if (opened.kind === "file") {
      files.push(childRel);
      continue;
    }
    listDirectory(sourceReal, opened.physical, childRel, childStack, files);
  }
}

/**
 * @param {{ workspace: string, source: string, rel: string, force: boolean }} input
 */
function classifyFile({ workspace, source, rel, force }) {
  const src = resolveRel(source, rel);
  const dest = resolveRel(workspace, rel);
  if (!isInside(workspace, dest)) {
    throw new SetupError(`refusing to write outside the workspace: ${rel}`);
  }
  assertDestinationContained(workspace, rel);
  let destStat = null;
  try {
    destStat = fs.lstatSync(dest);
  } catch (err) {
    if (!isMissing(err)) {
      throw new SetupError(`cannot read workspace path ${rel}: ${errorMessage(err)}`);
    }
  }
  if (destStat?.isDirectory()) {
    throw new SetupError(`${rel} exists as a directory in the workspace`);
  }
  if (destStat && !destStat.isSymbolicLink() && sameFile(src, dest)) {
    return { rel, action: "skip", reason: "source and workspace are the same file" };
  }
  if (destStat && !force) {
    return { rel, action: "skip", reason: "already exists" };
  }
  if (destStat && force) {
    return { rel, action: "overwrite", reason: "" };
  }
  return { rel, action: "copy", reason: "" };
}

/**
 * @param {{ workspace: string, install: string[] | null, skipInstall: boolean }} input
 */
function planInstall({ workspace, install, skipInstall }) {
  if (Array.isArray(install)) {
    if (skipInstall) {
      return emptyInstall("--skip-install", true);
    }
    if (install.length === 0) {
      return emptyInstall("install is empty", false);
    }
    return {
      commands: install,
      skipped: false,
      reason: "explicit",
      lockfile: null,
      manager: null,
    };
  }
  const detected = detectInstall(workspace);
  if (skipInstall) {
    return {
      commands: [],
      skipped: true,
      reason: "--skip-install",
      lockfile: detected.lockfile,
      manager: detected.manager,
    };
  }
  if (detected.commands.length === 0) {
    return emptyInstall("no lockfile", false);
  }
  return {
    commands: detected.commands,
    skipped: false,
    reason: "lockfile",
    lockfile: detected.lockfile,
    manager: detected.manager,
  };
}

/**
 * @param {string} reason
 * @param {boolean} skipped
 */
function emptyInstall(reason, skipped) {
  return { commands: [], skipped, reason, lockfile: null, manager: null };
}

/**
 * @param {{ workspace: string, copies: Array<{ rel: string, action: string, reason: string }>, enabled: boolean, skipTrust: boolean }} input
 */
function planDirenv({ workspace, copies, enabled, skipTrust }) {
  return planTool({
    tool: "direnv",
    command: "direnv allow",
    config: ".envrc",
    present: fileWillBeThere(workspace, ".envrc", copies),
    enabled,
    skipTrust,
    missingReason: "no .envrc",
  });
}

/**
 * @param {{ workspace: string, copies: Array<{ rel: string, action: string, reason: string }>, enabled: boolean, skipTrust: boolean }} input
 */
function planMise({ workspace, copies, enabled, skipTrust }) {
  const config = MISE_CONFIGS.find((rel) => fileWillBeThere(workspace, rel, copies)) ?? null;
  return planTool({
    tool: "mise",
    command: "mise trust",
    config: config ?? "mise.toml",
    present: config !== null,
    enabled,
    skipTrust,
    missingReason: "no mise config",
  });
}

/**
 * A trust config counts as present when this run will copy it in, or when
 * it is already a file in the workspace. Planning happens before copying.
 * @param {string} workspace
 * @param {string} rel
 * @param {Array<{ rel: string, action: string, reason: string }>} copies
 */
function fileWillBeThere(workspace, rel, copies) {
  const planned = copies.find((item) => item.rel === rel);
  if (planned?.action === "copy" || planned?.action === "overwrite") return true;
  if (planned?.action === "skip" && planned.reason !== "empty directory") return true;
  try {
    return fs.statSync(resolveRel(workspace, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   tool: string,
 *   command: string,
 *   config: string,
 *   present: boolean,
 *   enabled: boolean,
 *   skipTrust: boolean,
 *   missingReason: string,
 * }} input
 */
function planTool({ tool, command, config, present, enabled, skipTrust, missingReason }) {
  if (skipTrust) {
    return { tool, command, config, action: "skip", reason: "--skip-trust" };
  }
  if (!enabled) {
    return { tool, command, config, action: "skip", reason: "disabled" };
  }
  if (!present) {
    return { tool, command, config, action: "skip", reason: missingReason };
  }
  return { tool, command, config, action: "run", reason: config };
}

/**
 * @param {string} left
 * @param {string} right
 */
function sameFile(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} err
 */
function isMissing(err) {
  const code = codeOf(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * @param {unknown} err
 */
function codeOf(err) {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}

/**
 * @param {unknown} err
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
