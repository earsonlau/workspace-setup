import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/layerfs-workspace-setup.js", import.meta.url));

function run(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function roots(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(source);
  fs.mkdirSync(workspace);
  return { dir, source, workspace };
}

test("--help and --version", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  for (const text of ["apply", "check", "init", "--from", "--force", "--dry-run", "--skip-install", "--skip-trust"]) {
    assert.ok(help.stdout.includes(text), text);
  }
  const short = run(["-h"]);
  assert.equal(short.status, 0);
  assert.match(short.stdout, /layerfs-workspace-setup/);
  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^layerfs-workspace-setup \d+\.\d+\.\d+\n$/);
});

test("missing and unknown commands fail clearly", () => {
  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /command required/);
  assert.match(missing.stdout, /Usage:/);
  const unknown = run(["bootstrap"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command: bootstrap/);
});

test("init is idempotent unless --force, and dry-run writes nothing", (t) => {
  const dir = roots(t).dir;
  const created = run(["init", dir]);
  assert.equal(created.status, 0, created.stderr);
  const configPath = path.join(dir, ".layerfs", "setup.json");
  assert.match(created.stdout, new RegExp(`wrote ${escapeRegExp(configPath)}`));
  const body = fs.readFileSync(configPath, "utf8");
  assert.match(body, /"\.env"/);

  const again = run(["init", dir]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already exists/);
  assert.equal(fs.readFileSync(configPath, "utf8"), body);

  const fresh = path.join(dir, "fresh");
  fs.mkdirSync(fresh);
  const preview = run(["init", fresh, "--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /dry-run: would write /);
  assert.equal(fs.existsSync(path.join(fresh, ".layerfs", "setup.json")), false);

  fs.writeFileSync(configPath, "{}\n");
  const forced = run(["init", dir, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /overwritten/);
  assert.equal(fs.readFileSync(configPath, "utf8"), body);
});

test("check and dry-run do not copy; apply does, then skips", (t) => {
  const { source, workspace } = roots(t);
  fs.writeFileSync(path.join(source, ".env"), "TOKEN=1\n");
  fs.writeFileSync(path.join(source, ".npmrc"), "registry=local\n");
  fs.writeFileSync(path.join(workspace, "package-lock.json"), "");
  fs.mkdirSync(path.join(workspace, ".layerfs"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".layerfs", "setup.json"),
    JSON.stringify({ copy: [".env", ".npmrc"], trust: { direnv: false, mise: false } }),
  );

  const check = run(["check", workspace, "--from", source]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /\.env {2}copy/);
  assert.match(check.stdout, /npm ci {2}lockfile package-lock\.json/);
  assert.match(check.stdout, /check: no changes written/);
  assert.equal(fs.existsSync(path.join(workspace, ".env")), false);

  const dry = run(["apply", workspace, "--from", source, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run: no changes written/);
  assert.equal(fs.existsSync(path.join(workspace, ".env")), false);

  const applied = run(["apply", "--from", path.relative(workspace, source), "--skip-install"], {
    cwd: workspace,
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /applied/);
  assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "TOKEN=1\n");
  assert.equal(fs.readFileSync(path.join(workspace, ".npmrc"), "utf8"), "registry=local\n");

  const skipped = run(["apply", "--skip-install"], {
    cwd: workspace,
    env: { LAYERFS_SETUP_FROM: source },
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /already exists/);
  assert.match(skipped.stdout, /applied/);
});

test("unknown config keys fail before copy or install", (t) => {
  const { source, workspace } = roots(t);
  fs.writeFileSync(path.join(source, ".env"), "SECRET\n");
  fs.writeFileSync(path.join(workspace, "package-lock.json"), "");
  fs.mkdirSync(path.join(workspace, ".layerfs"));
  fs.writeFileSync(
    path.join(workspace, ".layerfs", "setup.json"),
    JSON.stringify({ copies: [".env"], installs: ["echo no"], trusts: { direnv: false } }),
  );
  const result = run(["apply", workspace, "--from", source]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error:.*unknown field "copies", "installs", "trusts"/);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(path.join(workspace, ".env")), false);
});

test("init refuses a .layerfs symlink that points outside", (t) => {
  const { dir, workspace } = roots(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const planted = path.join(outside, "setup.json");
  fs.writeFileSync(planted, "KEEP\n");
  fs.symlinkSync(path.join("..", "outside"), path.join(workspace, ".layerfs"));

  const init = run(["init", "--force"], { cwd: workspace });
  assert.equal(init.status, 1);
  assert.match(init.stderr, /error:.*refusing to write outside the workspace: \.layerfs\/setup\.json/);
  assert.equal(init.stdout, "");
  assert.equal(fs.readFileSync(planted, "utf8"), "KEEP\n");
  assert.deepEqual(fs.readdirSync(outside), ["setup.json"]);

  const dry = run(["init", workspace, "--dry-run"]);
  assert.equal(dry.status, 1);
  assert.match(dry.stderr, /error:.*refusing to write outside the workspace: \.layerfs\/setup\.json/);
  assert.equal(fs.readFileSync(planted, "utf8"), "KEEP\n");
});

test("apply refuses to load setup.json through an external .layerfs symlink", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const marker = path.join(dir, "marker");
  const planted = path.join(outside, "setup.json");
  fs.writeFileSync(
    planted,
    JSON.stringify({
      copy: [],
      install: [`node --eval "require('node:fs').writeFileSync(process.env.MARKER, 'x')"`],
      trust: { direnv: false, mise: false },
    }),
  );
  fs.symlinkSync(outside, path.join(workspace, ".layerfs"));
  const result = run(["apply", workspace, "--from", source], { env: { MARKER: marker } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error:.*refusing to write outside the workspace: \.layerfs\/setup\.json/);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(planted, "utf8").includes("MARKER"), true);
  assert.equal(fs.lstatSync(path.join(workspace, ".layerfs")).isSymbolicLink(), true);
});

test("apply refuses a workspace symlink that points outside", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "keep\n");
  fs.symlinkSync(outside, path.join(workspace, "nested"));
  fs.mkdirSync(path.join(source, "nested"));
  fs.writeFileSync(path.join(source, "nested", "secret.txt"), "new\n");
  fs.mkdirSync(path.join(workspace, ".layerfs"));
  fs.writeFileSync(
    path.join(workspace, ".layerfs", "setup.json"),
    JSON.stringify({
      copy: ["nested/secret.txt"],
      install: [],
      trust: { direnv: false, mise: false },
    }),
  );
  const result = run(["apply", workspace, "--from", source, "--force"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error:.*refusing to write outside the workspace: nested\/secret\.txt/);
  assert.equal(fs.readFileSync(secret, "utf8"), "keep\n");
  assert.equal(fs.lstatSync(path.join(workspace, "nested")).isSymbolicLink(), true);
});

test("invalid config and a missing workspace are errors", (t) => {
  const { workspace } = roots(t);
  fs.mkdirSync(path.join(workspace, ".layerfs"));
  fs.writeFileSync(path.join(workspace, ".layerfs", "setup.json"), "{");
  const bad = run(["check", workspace]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /error:.*setup\.json/);
  const missing = run(["apply", path.join(workspace, "nope")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /workspace does not exist/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
