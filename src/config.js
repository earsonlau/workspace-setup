import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./errors.js";
import {
  assertDestinationContained,
  assertResolvedParentInside,
  assertSafeRelative,
  containedRealpath,
  writeRegularFile,
} from "./paths.js";

export const CONFIG_RELATIVE = ".layerfs/setup.json";
export const DEFAULT_COPY = [".env", ".env.local", ".npmrc"];
const CONFIG_KEYS = new Set(["copy", "install", "trust"]);
const TRUST_KEYS = new Set(["direnv", "mise"]);

export function defaultConfig() {
  return {
    copy: [...DEFAULT_COPY],
    install: null,
    trust: { direnv: true, mise: true },
  };
}

export function starterConfig() {
  return {
    copy: [...DEFAULT_COPY],
    trust: { direnv: true, mise: true },
  };
}

/**
 * @param {string} workspace
 */
export function configPathFor(workspace) {
  return path.join(workspace, ".layerfs", "setup.json");
}

/**
 * @param {unknown} value
 * @param {string} where
 */
export function normalizeConfig(value, where = ".layerfs/setup.json") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupError(`${where} must be a JSON object`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknownKeys(record, CONFIG_KEYS, where);
  return {
    copy: normalizeCopy(record.copy, where),
    install: normalizeInstall(record.install, where),
    trust: normalizeTrust(record.trust, where),
  };
}

/**
 * @param {string} workspace
 */
export function loadConfig(workspace) {
  const configPath = configPathFor(workspace);
  rejectEscapingConfigDir(workspace);
  const real = containedRealpath(workspace, CONFIG_RELATIVE);
  if (real === null) {
    return { config: defaultConfig(), configPath, origin: "defaults" };
  }
  const text = readRegularFile(real, configPath);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SetupError(`${configPath}: ${message}`);
  }
  return {
    config: normalizeConfig(parsed, configPath),
    configPath,
    origin: "file",
  };
}

/**
 * `.layerfs` has to stay inside the project before a config is read.
 * A non-directory, non-symlink `.layerfs` cannot hold `setup.json`, so the
 * caller keeps the defaults. A symlink that leaves the project throws.
 * @param {string} workspace
 */
function rejectEscapingConfigDir(workspace) {
  const layer = path.join(workspace, ".layerfs");
  let listed;
  try {
    listed = fs.lstatSync(layer);
  } catch (err) {
    if (isMissingPath(err)) return;
    throw new SetupError(`cannot read workspace path ${CONFIG_RELATIVE}: ${messageOf(err)}`);
  }
  if (!listed.isDirectory() && !listed.isSymbolicLink()) return;
  assertDestinationContained(workspace, CONFIG_RELATIVE);
}

/**
 * Read `real`, which has already been checked to stay inside the workspace.
 * `O_NOFOLLOW` refuses a symlink swapped in after that check.
 * @param {string} real
 * @param {string} configPath
 */
function readRegularFile(real, configPath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  /** @type {number | undefined} */
  let fd;
  try {
    fd = fs.openSync(real, flags);
    if (!fs.fstatSync(fd).isFile()) {
      throw new SetupError(`${configPath} is not a file`);
    }
    return fs.readFileSync(fd, "utf8");
  } catch (err) {
    if (err instanceof SetupError) throw err;
    if (isMissingPath(err)) {
      throw new SetupError(`${configPath} is not a file`);
    }
    throw new SetupError(`${configPath}: ${messageOf(err)}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original error is the one to report.
      }
    }
  }
}

/**
 * @param {string} dir
 * @param {{ force?: boolean, dryRun?: boolean }} [options]
 */
export function writeStarter(dir, { force = false, dryRun = false } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new SetupError(`directory does not exist: ${root}`);
  }
  const configPath = configPathFor(root);
  assertDestinationContained(root, CONFIG_RELATIVE);
  const existing = lstatOrNull(configPath);
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    throw new SetupError(`${configPath} is not a file`);
  }
  if (existing && !force) {
    return { configPath, written: false, reason: "already exists" };
  }
  if (dryRun) {
    return {
      configPath,
      written: false,
      reason: existing ? "would overwrite" : "would write",
    };
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  assertResolvedParentInside(root, CONFIG_RELATIVE);
  const fresh = lstatOrNull(configPath);
  if (fresh && !fresh.isFile() && !fresh.isSymbolicLink()) {
    throw new SetupError(`${configPath} is not a file`);
  }
  try {
    writeRegularFile(configPath, `${JSON.stringify(starterConfig(), null, 2)}\n`);
  } catch (err) {
    if (err instanceof SetupError) throw err;
    throw new SetupError(`failed to write ${configPath}: ${messageOf(err)}`);
  }
  return { configPath, written: true, reason: existing ? "overwritten" : "wrote" };
}

/**
 * @param {string} target
 * @returns {fs.Stats | null}
 */
function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    if (isMissingPath(err)) return null;
    throw new SetupError(`cannot read ${target}: ${messageOf(err)}`);
  }
}

/**
 * @param {unknown} err
 */
function isMissingPath(err) {
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
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function normalizeCopy(value, where) {
  if (value === undefined) return [...DEFAULT_COPY];
  if (!Array.isArray(value)) {
    throw new SetupError(`${where}: copy must be an array of relative paths`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new SetupError(`${where}: copy[${index}] must be a string`);
    }
    return assertSafeRelative(entry, `${where}: copy[${index}]`);
  });
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string[] | null}
 */
function normalizeInstall(value, where) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new SetupError(`${where}: install must be an array of shell commands`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new SetupError(`${where}: install[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function normalizeTrust(value, where) {
  if (value === undefined) return { direnv: true, mise: true };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupError(`${where}: trust must be an object`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknownKeys(record, TRUST_KEYS, `${where}: trust`);
  return {
    direnv: booleanField(record.direnv, true, `${where}: trust.direnv`),
    mise: booleanField(record.mise, true, `${where}: trust.mise`),
  };
}

/**
 * Unknown keys must not fall through to the defaults. A typo such as
 * `copies` would otherwise copy `.env` and run install.
 * @param {Record<string, unknown>} record
 * @param {Set<string>} allowed
 * @param {string} where
 */
function rejectUnknownKeys(record, allowed, where) {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  const names = unknown.map((key) => JSON.stringify(key)).join(", ");
  throw new SetupError(`${where}: unknown field ${names}`);
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} label
 */
function booleanField(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new SetupError(`${label} must be a boolean`);
  }
  return value;
}
