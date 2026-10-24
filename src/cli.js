import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { applyPlan } from "./apply.js";
import { loadConfig, writeStarter } from "./config.js";
import { SetupError } from "./errors.js";
import { planSetup } from "./plan.js";
import { formatReport } from "./report.js";

const HELP = `layerfs-workspace-setup — bootstrap a LayerFS workspace

Usage:
  layerfs-workspace-setup apply [workspace]
  layerfs-workspace-setup check [workspace]
  layerfs-workspace-setup init [dir]
  layerfs-workspace-setup --help
  layerfs-workspace-setup --version

Commands:
  apply   Copy local files, trust direnv and mise, then run install commands
  check   Report the plan and anything missing
  init    Write a starter .layerfs/setup.json

Options:
  --from <source>   Tree that holds the files named in copy
                    (default: $LAYERFS_SETUP_FROM, or the workspace itself)
  --force           Overwrite files that already exist in the workspace
  --dry-run         Print the plan without writing files or running commands
  --skip-install    Do not run install commands
  --skip-trust      Do not run direnv allow or mise trust
  -h, --help        Show this help
  --version         Show the package version

Config:
  .layerfs/setup.json in the workspace. A missing file uses defaults:
  copy .env, .env.local, and .npmrc; install from the lockfile; trust both tools.
  Unknown fields are an error. Trust and install run again on every apply;
  pass --skip-trust and --skip-install to copy files only.
  init, check, and apply refuse when .layerfs resolves outside the directory.

Examples:
  layerfs-workspace-setup init
  layerfs-workspace-setup check . --from ~/src/app
  layerfs-workspace-setup apply /workspaces/1 --from ~/src/app
  layerfs-workspace-setup apply --dry-run --skip-install

Exit codes:
  0  success, including check and dry-run
  1  usage error, invalid config, or a failed copy, trust, or install step
`;

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, stdout?: (chunk: string) => void, stderr?: (chunk: string) => void }} [io]
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? ((chunk) => process.stdout.write(chunk));
  const stderr = io.stderr ?? ((chunk) => process.stderr.write(chunk));
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  try {
    return run(argv, { stdout, stderr, env, cwd });
  } catch (err) {
    if (err instanceof SetupError) {
      stderr(`error: ${err.message}\n`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    stderr(`error: ${message}\n`);
    return 1;
  }
}

/**
 * @param {string[]} argv
 * @param {{ stdout: (chunk: string) => void, stderr: (chunk: string) => void, env: NodeJS.ProcessEnv, cwd: string }} io
 */
function run(argv, { stdout, stderr, env, cwd }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        from: { type: "string" },
        force: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "skip-install": { type: "boolean", default: false },
        "skip-trust": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
        h: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    throw new SetupError(err instanceof Error ? err.message : String(err));
  }

  const { values, positionals } = parsed;
  if (values.help || values.h || positionals[0] === "help") {
    stdout(HELP);
    return 0;
  }
  if (values.version) {
    stdout(`${readVersion()}\n`);
    return 0;
  }

  const command = positionals[0];
  if (!command) {
    stdout(HELP);
    throw new SetupError("command required");
  }
  if (positionals.length > 2) {
    throw new SetupError(`unexpected argument: ${positionals[2]}`);
  }

  if (command === "init") {
    return initCommand(positionals[1] ? path.resolve(cwd, positionals[1]) : cwd, values, stdout);
  }
  if (command === "apply" || command === "check") {
    return setupCommand(command, positionals[1], values, { stdout, env, cwd });
  }
  throw new SetupError(`unknown command: ${command}`);
}

/**
 * @param {string} dir
 * @param {{ force?: boolean, "dry-run"?: boolean }} values
 * @param {(chunk: string) => void} stdout
 */
function initCommand(dir, values, stdout) {
  const result = writeStarter(dir, {
    force: values.force === true,
    dryRun: values["dry-run"] === true,
  });
  if (result.reason === "already exists") {
    stdout(`skip ${result.configPath} (already exists)\n`);
    return 0;
  }
  if (!result.written) {
    stdout(`dry-run: ${result.reason} ${result.configPath}\n`);
    return 0;
  }
  stdout(`${result.reason} ${result.configPath}\n`);
  return 0;
}

/**
 * @param {"apply" | "check"} command
 * @param {string | undefined} workspaceArg
 * @param {{ from?: string, force?: boolean, "dry-run"?: boolean, "skip-install"?: boolean, "skip-trust"?: boolean }} values
 * @param {{ stdout: (chunk: string) => void, env: NodeJS.ProcessEnv, cwd: string }} io
 */
function setupCommand(command, workspaceArg, values, { stdout, env, cwd }) {
  const workspace = requireDirectory(
    workspaceArg ? path.resolve(cwd, workspaceArg) : cwd,
    "workspace",
  );
  const source = requireDirectory(resolveSource(workspace, values.from, env, cwd), "source");
  const loaded = loadConfig(workspace);
  const dryRun = command === "check" || values["dry-run"] === true;
  const plan = planSetup({
    workspace,
    source,
    config: loaded.config,
    configPath: loaded.configPath,
    origin: loaded.origin,
    force: values.force === true,
    skipInstall: values["skip-install"] === true,
    skipTrust: values["skip-trust"] === true,
  });
  stdout(formatReport(plan));
  if (dryRun) {
    stdout(`${command === "check" ? "check" : "dry-run"}: no changes written\n`);
    return 0;
  }
  applyPlan(plan, { env });
  stdout("applied\n");
  return 0;
}

/**
 * @param {string} workspace
 * @param {string | undefined} from
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 */
function resolveSource(workspace, from, env, cwd) {
  if (from !== undefined && from.trim() === "") {
    throw new SetupError("--from requires a path");
  }
  if (from) return path.resolve(cwd, from);
  if (env.LAYERFS_SETUP_FROM && env.LAYERFS_SETUP_FROM.trim() !== "") {
    return path.resolve(cwd, env.LAYERFS_SETUP_FROM);
  }
  return workspace;
}

/**
 * @param {string} dir
 * @param {string} label
 */
function requireDirectory(dir, label) {
  if (!fs.existsSync(dir)) {
    throw new SetupError(`${label} does not exist: ${dir}`);
  }
  if (!fs.statSync(dir).isDirectory()) {
    throw new SetupError(`${label} is not a directory: ${dir}`);
  }
  return dir;
}

function readVersion() {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return `${pkg.name} ${pkg.version}`;
}
