import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./errors.js";

/**
 * Accept a project-relative path and return it with `/` separators.
 * Absolute paths and `..` segments that leave the project are rejected.
 * @param {string} input
 * @param {string} label
 */
export function assertSafeRelative(input, label) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new SetupError(`${label} must be a non-empty relative path`);
  }
  if (input.includes("\0")) {
    throw new SetupError(`${label} contains a null byte`);
  }
  const slashed = input.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    throw new SetupError(`${label} must be a relative path`);
  }
  const normalized = path.posix.normalize(slashed);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "." ||
    normalized.startsWith("/")
  ) {
    throw new SetupError(`${label} must stay inside the project`);
  }
  return normalized;
}

/**
 * @param {string} root
 * @param {string} rel posix relative path
 */
export function resolveRel(root, rel) {
  const parts = rel.split("/").filter((part) => part.length > 0);
  return path.resolve(root, ...parts);
}

/**
 * @param {string} root
 * @param {string} target
 */
export function isInside(root, target) {
  const from = path.resolve(root);
  const to = path.resolve(target);
  const rel = path.relative(from, to);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Refuse to read `rel` through a parent symlink that resolves outside
 * `source`. The leaf may still be a symlink to a file outside the source;
 * that link is copied as a regular file. Cycles are refused with `rel`,
 * not with the expanded chain.
 * @param {string} source
 * @param {string} rel
 */
export function assertSourceAncestorsContained(source, rel) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(source);
  } catch (err) {
    throw new SetupError(`cannot read ${rel}: ${errorText(err)}`);
  }
  const parts = rel.split("/").filter((part) => part.length > 0);
  let current = rootReal;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = path.join(current, parts[i]);
    const relSoFar = parts.slice(0, i + 1).join("/");
    let listed;
    try {
      listed = fs.lstatSync(next);
    } catch (err) {
      if (isMissingPath(err)) {
        throw new SetupError(`failed to copy ${rel}: ${errorText(err)}`);
      }
      throw new SetupError(`cannot read ${relSoFar}: ${errorText(err)}`);
    }
    if (listed.isSymbolicLink()) {
      current = containedDirectory(next, rootReal, relSoFar, "source");
      continue;
    }
    if (!listed.isDirectory()) {
      throw new SetupError(`cannot read ${rel}: ${relSoFar} is not a directory`);
    }
    current = next;
  }
}

/**
 * Refuse to create or replace `rel` when a parent directory is a symlink
 * whose target resolves outside `workspace`. Parents that do not exist yet
 * are fine: they will be created under the last real directory that stayed
 * inside. The leaf itself may be a symlink or a hard link; callers replace
 * that directory entry instead of opening it. `init` uses this for
 * `.layerfs/setup.json`, and config loading uses it before reading.
 * @param {string} workspace
 * @param {string} rel
 */
export function assertDestinationContained(workspace, rel) {
  const rootReal = realPathOf(workspace, rel);
  const parts = rel.split("/").filter((part) => part.length > 0);
  let current = rootReal;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = path.join(current, parts[i]);
    const relSoFar = parts.slice(0, i + 1).join("/");
    let listed;
    try {
      listed = fs.lstatSync(next);
    } catch (err) {
      if (isMissingPath(err)) {
        if (!isInside(rootReal, current)) {
          throw new SetupError(`refusing to write outside the workspace: ${rel}`);
        }
        return;
      }
      throw new SetupError(`cannot read workspace path ${rel}: ${errorText(err)}`);
    }
    if (listed.isSymbolicLink()) {
      current = containedDirectory(next, rootReal, rel, "workspace");
      continue;
    }
    if (!listed.isDirectory()) {
      throw new SetupError(`${relSoFar} exists as a non-directory in the workspace`);
    }
    current = next;
  }
  if (!isInside(rootReal, current)) {
    throw new SetupError(`refusing to write outside the workspace: ${rel}`);
  }
}

/**
 * After parent directories exist, confirm the resolved parent is still
 * inside the workspace. This catches a symlink that appeared between the
 * plan and the write.
 * @param {string} workspace
 * @param {string} rel
 */
export function assertResolvedParentInside(workspace, rel) {
  const rootReal = realPathOf(workspace, rel);
  const parent = path.dirname(resolveRel(workspace, rel));
  let parentReal;
  try {
    parentReal = fs.realpathSync(parent);
  } catch {
    throw new SetupError(`refusing to write outside the workspace: ${rel}`);
  }
  if (!isInside(rootReal, parentReal)) {
    throw new SetupError(`refusing to write outside the workspace: ${rel}`);
  }
}

/**
 * Real path of `rel` when that path stays inside `workspace`.
 * A missing or dangling path returns null. A path that resolves outside,
 * including through `.layerfs`, throws.
 * @param {string} workspace
 * @param {string} rel
 * @returns {string | null}
 */
export function containedRealpath(workspace, rel) {
  const rootReal = realPathOf(workspace, rel);
  let real;
  try {
    real = fs.realpathSync(resolveRel(workspace, rel));
  } catch (err) {
    if (isMissingPath(err)) return null;
    throw new SetupError(`cannot read workspace path ${rel}: ${errorText(err)}`);
  }
  if (!isInside(rootReal, real)) {
    throw new SetupError(`refusing to write outside the workspace: ${rel}`);
  }
  return real;
}

let tempSequence = 0;

/**
 * Replace `dest` with a new regular file containing `contents`.
 * The previous directory entry is not opened: a symlink is not followed,
 * and a hard link's other names keep their old bytes. Pass `mode` to force
 * permission bits; omit it to leave the process umask in place.
 * @param {string} dest
 * @param {string | Buffer} contents
 * @param {number} [mode]
 */
export function writeRegularFile(dest, contents, mode) {
  const openMode = mode === undefined ? 0o666 : mode & 0o777;
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const created = openTemp(path.dirname(dest), flags, openMode);
  try {
    fs.writeFileSync(created.fd, contents);
    if (mode !== undefined) fs.fchmodSync(created.fd, openMode);
    fs.closeSync(created.fd);
    created.fd = undefined;
    fs.renameSync(created.tmp, dest);
    created.tmp = undefined;
  } finally {
    if (created.fd !== undefined) {
      try {
        fs.closeSync(created.fd);
      } catch {
        // The original error is the one to report.
      }
    }
    if (created.tmp !== undefined) {
      try {
        fs.unlinkSync(created.tmp);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * @param {string} dir
 * @param {number} flags
 * @param {number} openMode
 * @returns {{ fd: number | undefined, tmp: string | undefined }}
 */
function openTemp(dir, flags, openMode) {
  /** @type {unknown} */
  let last = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    tempSequence += 1;
    const tmp = path.join(dir, `.lfs-${process.pid}-${tempSequence}.tmp`);
    try {
      return { fd: fs.openSync(tmp, flags, openMode), tmp };
    } catch (err) {
      last = err;
      if (codeOf(err) !== "EEXIST") throw err;
    }
  }
  throw last instanceof Error ? last : new Error("could not create a temporary file");
}

/**
 * @param {string} linkPath
 * @param {string} rootReal
 * @param {string} rel
 * @param {"source" | "workspace"} side
 */
function containedDirectory(linkPath, rootReal, rel, side) {
  let target;
  try {
    target = fs.realpathSync(linkPath);
  } catch (err) {
    if (codeOf(err) === "ELOOP") {
      throw new SetupError(`refusing to follow directory symlink cycle: ${rel}`);
    }
    if (side === "workspace") {
      throw new SetupError(`refusing to write outside the workspace: ${rel}`);
    }
    throw new SetupError(`cannot read ${rel}: ${errorText(err)}`);
  }
  if (!isInside(rootReal, target)) {
    if (side === "workspace") {
      throw new SetupError(`refusing to write outside the workspace: ${rel}`);
    }
    throw new SetupError(
      `refusing to follow directory symlink outside the source tree: ${rel} -> ${target}`,
    );
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (side === "workspace") {
      throw new SetupError(`refusing to write outside the workspace: ${rel}`);
    }
    throw new SetupError(`cannot read ${rel}: ${errorText(err)}`);
  }
  if (!stat.isDirectory()) {
    if (side === "workspace") {
      throw new SetupError(`refusing to write outside the workspace: ${rel}`);
    }
    throw new SetupError(`cannot read ${rel}: not a directory`);
  }
  return target;
}

/**
 * @param {string} root
 * @param {string} rel
 */
function realPathOf(root, rel) {
  try {
    return fs.realpathSync(root);
  } catch (err) {
    throw new SetupError(`cannot read workspace path ${rel}: ${errorText(err)}`);
  }
}

/**
 * @param {unknown} err
 */
function isMissingPath(err) {
  return codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR";
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
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
