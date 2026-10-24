import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SetupError, applyPlan, copyFile, normalizeConfig, planSetup } from "../src/index.js";

function roots(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(source);
  fs.mkdirSync(workspace);
  return { dir, source, workspace };
}

function plan(workspace, source, body, options = {}) {
  return planSetup({
    workspace,
    source,
    config: normalizeConfig(body),
    configPath: path.join(workspace, ".layerfs", "setup.json"),
    origin: "file",
    ...options,
  });
}

test("apply copies files, preserves mode, and skips them on the next run", (t) => {
  const { source, workspace } = roots(t);
  const env = path.join(source, ".env");
  fs.writeFileSync(env, "TOKEN=1\n", { mode: 0o600 });
  fs.mkdirSync(path.join(source, "certs"));
  fs.writeFileSync(path.join(source, "certs", "dev.pem"), "cert\n");

  const body = { copy: [".env", "certs/dev.pem"], install: [], trust: { direnv: false, mise: false } };
  const first = applyPlan(plan(workspace, source, body), { stdio: "pipe" });
  assert.deepEqual(
    first.executed.map((item) => item.rel),
    [".env", "certs/dev.pem"],
  );
  assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "TOKEN=1\n");
  assert.equal(fs.statSync(path.join(workspace, ".env")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(workspace, "certs", "dev.pem"), "utf8"), "cert\n");

  fs.writeFileSync(env, "TOKEN=2\n", { mode: 0o600 });
  const second = applyPlan(plan(workspace, source, body), { stdio: "pipe" });
  assert.equal(second.executed.length, 0);
  assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "TOKEN=1\n");

  const forced = applyPlan(plan(workspace, source, body, { force: true }), { stdio: "pipe" });
  assert.equal(forced.executed.length, 2);
  assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "TOKEN=2\n");
});

test("dry-run apply writes nothing", (t) => {
  const { source, workspace } = roots(t);
  fs.writeFileSync(path.join(source, ".env"), "x\n");
  const planned = plan(workspace, source, { copy: [".env"], install: [], trust: { direnv: false, mise: false } });
  const result = applyPlan(planned, { dryRun: true, stdio: "pipe" });
  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(path.join(workspace, ".env")), false);
});

test("a source symlink is copied as file contents", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "secret");
  fs.writeFileSync(outside, "from-outside\n");
  fs.symlinkSync(outside, path.join(source, ".env"));
  applyPlan(
    plan(workspace, source, { copy: [".env"], install: [], trust: { direnv: false, mise: false } }),
    { stdio: "pipe" },
  );
  const dest = path.join(workspace, ".env");
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(dest, "utf8"), "from-outside\n");
});

test("--force replaces a destination symlink without writing through it", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "keep");
  fs.writeFileSync(outside, "keep\n");
  fs.writeFileSync(path.join(source, ".env"), "new\n");
  const link = path.join(workspace, ".env");
  fs.symlinkSync(outside, link);
  const body = { copy: [".env"], install: [], trust: { direnv: false, mise: false } };

  applyPlan(plan(workspace, source, body), { stdio: "pipe" });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");

  applyPlan(plan(workspace, source, body, { force: true }), { stdio: "pipe" });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(link, "utf8"), "new\n");
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
});

test("--force replaces a hard-linked destination without updating the other name", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "keep");
  fs.writeFileSync(outside, "keep\n");
  fs.writeFileSync(path.join(source, ".env"), "new\n", { mode: 0o600 });
  const link = path.join(workspace, ".env");
  fs.linkSync(outside, link);
  const outsideIno = fs.statSync(outside).ino;
  const body = { copy: [".env"], install: [], trust: { direnv: false, mise: false } };

  applyPlan(plan(workspace, source, body), { stdio: "pipe" });
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
  assert.equal(fs.statSync(link).ino, outsideIno);

  applyPlan(plan(workspace, source, body, { force: true }), { stdio: "pipe" });
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
  assert.equal(fs.statSync(outside).ino, outsideIno);
  assert.notEqual(fs.statSync(link).ino, outsideIno);
  assert.equal(fs.readFileSync(link, "utf8"), "new\n");
  assert.equal(fs.statSync(link).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.deepEqual(
    fs.readdirSync(workspace).filter((name) => name.startsWith(".lfs-")),
    [],
  );
});

test("a workspace ancestor symlink cannot receive a copy", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const kept = path.join(outside, "secret.txt");
  const created = path.join(outside, "new.txt");
  fs.writeFileSync(kept, "keep-me\n");
  fs.symlinkSync(outside, path.join(workspace, "nested"));
  fs.mkdirSync(path.join(source, "nested"));
  fs.writeFileSync(path.join(source, "nested", "secret.txt"), "from-source\n");
  fs.writeFileSync(path.join(source, "nested", "new.txt"), "nope\n");
  const body = {
    copy: ["nested/secret.txt", "nested/new.txt"],
    install: [],
    trust: { direnv: false, mise: false },
  };
  const before = fs.readFileSync(kept);
  assert.throws(
    () => plan(workspace, source, body),
    (err) => {
      assert.ok(err instanceof SetupError);
      assert.match(err.message, /refusing to write outside the workspace: nested\/secret\.txt/);
      return true;
    },
  );
  assert.throws(
    () => plan(workspace, source, body, { force: true }),
    /refusing to write outside the workspace: nested\/secret\.txt/,
  );
  assert.deepEqual(fs.readFileSync(kept), before);
  assert.equal(fs.existsSync(created), false);
  assert.throws(
    () => copyFile(source, workspace, "nested/new.txt"),
    /refusing to write outside the workspace: nested\/new\.txt/,
  );
  assert.deepEqual(fs.readFileSync(kept), before);
  assert.equal(fs.existsSync(created), false);
  assert.equal(fs.lstatSync(path.join(workspace, "nested")).isSymbolicLink(), true);
});

test("a workspace symlink that stays inside is written through", (t) => {
  const { source, workspace } = roots(t);
  fs.mkdirSync(path.join(workspace, "real"));
  fs.symlinkSync("real", path.join(workspace, "alias"));
  fs.mkdirSync(path.join(source, "alias"));
  fs.writeFileSync(path.join(source, "alias", "note"), "inside\n");
  applyPlan(
    plan(workspace, source, {
      copy: ["alias/note"],
      install: [],
      trust: { direnv: false, mise: false },
    }),
    { stdio: "pipe" },
  );
  assert.equal(fs.lstatSync(path.join(workspace, "alias")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(workspace, "real", "note"), "utf8"), "inside\n");
  assert.equal(fs.readFileSync(path.join(workspace, "alias", "note"), "utf8"), "inside\n");
});

test("an in-source directory symlink is copied as real files", (t) => {
  const { source, workspace } = roots(t);
  fs.mkdirSync(path.join(source, "real"));
  fs.writeFileSync(path.join(source, "real", "a"), "a\n");
  fs.symlinkSync("real", path.join(source, "alias"));
  applyPlan(
    plan(workspace, source, { copy: ["alias"], install: [], trust: { direnv: false, mise: false } }),
    { stdio: "pipe" },
  );
  const dest = path.join(workspace, "alias", "a");
  assert.equal(fs.lstatSync(path.join(workspace, "alias")).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(workspace, "alias")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(dest, "utf8"), "a\n");
});

test("a copied directory follows file symlinks and not external directory symlinks", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "id_rsa"), "secret-key\n");
  fs.writeFileSync(path.join(dir, "token"), "from-outside\n");
  fs.mkdirSync(path.join(source, "secrets"));
  fs.symlinkSync(path.join(dir, "token"), path.join(source, "secrets", "token"));
  fs.symlinkSync(outside, path.join(source, "secrets", "keys"));
  assert.throws(
    () =>
      plan(workspace, source, {
        copy: ["secrets"],
        install: [],
        trust: { direnv: false, mise: false },
      }),
    /refusing to follow directory symlink outside the source tree: secrets\/keys -> /,
  );
  assert.equal(fs.existsSync(path.join(workspace, "secrets")), false);
  assert.equal(fs.readFileSync(path.join(outside, "id_rsa"), "utf8"), "secret-key\n");
});

test("install runs again on a second apply", (t) => {
  const { dir, source, workspace } = roots(t);
  const log = path.join(dir, "log");
  fs.writeFileSync(path.join(source, ".env"), "x\n");
  const install = `node --eval "require('node:fs').appendFileSync(process.env.INSTALL_LOG, 'ran\\n')"`;
  const body = { copy: [".env"], install: [install], trust: { direnv: false, mise: false } };
  const env = { ...process.env, INSTALL_LOG: log };
  const first = applyPlan(plan(workspace, source, body), { stdio: "pipe", env });
  const second = applyPlan(plan(workspace, source, body), { stdio: "pipe", env });
  assert.equal(first.executed.at(-1).command, install);
  assert.equal(second.executed.length, 1);
  assert.equal(second.executed[0].command, install);
  assert.equal(fs.readFileSync(log, "utf8"), "ran\nran\n");
});

test("trust runs after the copied config exists, then install runs", (t) => {
  const { dir, source, workspace } = roots(t);
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "log");
  fs.mkdirSync(bin);
  const script = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(log)}\nprintf '%s\\n' "MISE_YES=$MISE_YES" >> ${JSON.stringify(log)}\nprintf '%s\\n' "$PWD" >> ${JSON.stringify(log)}\n`;
  for (const name of ["direnv", "mise"]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, script);
    fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(path.join(source, ".envrc"), "export FOO=1\n");
  fs.writeFileSync(path.join(source, "mise.toml"), "");
  const marker = path.join(workspace, "installed.txt");
  const install = `node --eval "require('node:fs').writeFileSync('installed.txt','ok')"`;
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
  };
  delete env.MISE_YES;
  const result = applyPlan(
    plan(workspace, source, { copy: [".envrc", "mise.toml"], install: [install] }),
    { env, stdio: "pipe" },
  );
  assert.deepEqual(
    result.executed.map((item) => item.command ?? item.rel),
    [".envrc", "mise.toml", "direnv allow", "mise trust", install],
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "ok");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.match(lines[0], /direnv allow$/);
  assert.equal(lines[1], "MISE_YES=");
  assert.equal(lines[2], workspace);
  assert.match(lines[3], /mise trust$/);
  assert.equal(lines[4], "MISE_YES=1");
  assert.equal(lines[5], workspace);
});

test("a missing trust binary fails with the tool name before install", (t) => {
  const { dir, source, workspace } = roots(t);
  fs.writeFileSync(path.join(workspace, ".envrc"), "export FOO=1\n");
  fs.writeFileSync(path.join(source, ".env"), "x\n");
  const empty = path.join(dir, "empty-bin");
  fs.mkdirSync(empty);
  const planned = plan(workspace, source, {
    copy: [".env"],
    install: ["node --eval \"process.exit(9)\""],
  });
  assert.throws(
    () => applyPlan(planned, { env: { ...process.env, PATH: empty }, stdio: "pipe" }),
    (err) => {
      assert.ok(err instanceof SetupError);
      assert.match(err.message, /direnv is not on PATH/);
      assert.match(err.message, /--skip-trust/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "x\n");
  assert.equal(fs.existsSync(path.join(workspace, "installed.txt")), false);
});

test("a failed install keeps the copied file and names the exit code", (t) => {
  const { source, workspace } = roots(t);
  fs.writeFileSync(path.join(source, ".env"), "stay\n");
  const planned = plan(workspace, source, {
    copy: [".env"],
    install: ["node --eval \"process.exit(3)\""],
    trust: { direnv: false, mise: false },
  });
  assert.throws(
    () => applyPlan(planned, { stdio: "pipe" }),
    (err) => {
      assert.ok(err instanceof SetupError);
      assert.match(err.message, /install failed \(exit 3\)/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "stay\n");
});
