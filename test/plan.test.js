import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SetupError, formatReport, loadConfig, normalizeConfig, planSetup } from "../src/index.js";

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
  const config = normalizeConfig(body);
  return planSetup({
    workspace,
    source,
    config,
    configPath: path.join(workspace, ".layerfs", "setup.json"),
    origin: "file",
    ...options,
  });
}

test("dry-run copy classifies new, existing, forced, and missing files", (t) => {
  const { source, workspace } = roots(t);
  fs.writeFileSync(path.join(source, ".env"), "TOKEN=1\n");
  fs.writeFileSync(path.join(source, ".npmrc"), "registry=https://example.test\n");
  fs.writeFileSync(path.join(workspace, ".npmrc"), "already\n");
  fs.mkdirSync(path.join(source, "certs"));
  fs.writeFileSync(path.join(source, "certs", "dev.pem"), "cert");
  fs.writeFileSync(path.join(workspace, "certs-existing"), "keep");

  const first = plan(workspace, source, {
    copy: [".env", ".env.local", ".npmrc", "certs"],
    install: [],
    trust: { direnv: false, mise: false },
  });
  assert.deepEqual(
    first.copies.map((item) => [item.rel, item.action, item.reason]),
    [
      [".env", "copy", ""],
      [".env.local", "absent", "not in source"],
      [".npmrc", "skip", "already exists"],
      ["certs/dev.pem", "copy", ""],
    ],
  );
  const report = formatReport(first);
  assert.match(report, /\.env {2}copy/);
  assert.match(report, /\.env\.local {2}absent {2}not in source/);
  assert.match(report, /\.npmrc {2}skip {2}already exists/);
  assert.match(report, /certs\/dev\.pem {2}copy/);
  assert.match(report, /summary: 2 copy, 0 overwrite, 1 skip, 1 absent, 0 install, 0 trust/);
  assert.equal(fs.existsSync(path.join(workspace, ".env")), false);

  const forced = plan(
    workspace,
    source,
    { copy: [".npmrc"], install: [], trust: { direnv: false, mise: false } },
    { force: true },
  );
  assert.equal(forced.copies[0].action, "overwrite");
  assert.equal(fs.readFileSync(path.join(workspace, ".npmrc"), "utf8"), "already\n");
});

test("the same file is skipped even with --force", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".env"), "local\n");
  const planned = plan(dir, dir, { copy: [".env"], install: [], trust: { direnv: false, mise: false } }, { force: true });
  assert.equal(planned.copies[0].action, "skip");
  assert.match(planned.copies[0].reason, /same file/);
});

test("a directory copy skips files that already exist", (t) => {
  const { source, workspace } = roots(t);
  fs.mkdirSync(path.join(source, "secrets"));
  fs.writeFileSync(path.join(source, "secrets", "a"), "a");
  fs.writeFileSync(path.join(source, "secrets", "b"), "b");
  fs.mkdirSync(path.join(workspace, "secrets"));
  fs.writeFileSync(path.join(workspace, "secrets", "a"), "keep");
  const planned = plan(workspace, source, {
    copy: ["secrets"],
    install: [],
    trust: { direnv: false, mise: false },
  });
  assert.deepEqual(
    planned.copies.map((item) => [item.rel, item.action]),
    [
      ["secrets/a", "skip"],
      ["secrets/b", "copy"],
    ],
  );
});

test("a directory symlink outside the source is not walked", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "id_rsa"), "secret-key\n");
  fs.symlinkSync(outside, path.join(source, "keys"));
  const body = { copy: ["keys"], install: [], trust: { direnv: false, mise: false } };
  assert.throws(
    () => plan(workspace, source, body),
    (err) => {
      assert.ok(err instanceof SetupError);
      assert.match(err.message, /refusing to follow directory symlink outside the source tree: keys -> /);
      assert.ok(err.message.includes(outside));
      assert.equal(err.message.includes("id_rsa/id_rsa"), false);
      return true;
    },
  );
  assert.throws(
    () => plan(workspace, source, { ...body, copy: ["keys/id_rsa"] }),
    /refusing to follow directory symlink outside the source tree: keys -> /,
  );
  assert.equal(fs.existsSync(path.join(workspace, "keys")), false);
  assert.equal(fs.readFileSync(path.join(outside, "id_rsa"), "utf8"), "secret-key\n");
});

test("a directory symlink cycle names the original path", (t) => {
  const { source, workspace } = roots(t);
  const loop = path.join(source, "loop");
  fs.mkdirSync(loop);
  fs.writeFileSync(path.join(loop, "ok.txt"), "ok\n");
  fs.symlinkSync(".", path.join(loop, "again"));
  assert.throws(
    () => plan(workspace, source, { copy: ["loop"], install: [], trust: { direnv: false, mise: false } }),
    (err) => {
      assert.ok(err instanceof SetupError);
      assert.equal(err.message, "refusing to follow directory symlink cycle: loop/again");
      return true;
    },
  );

  fs.unlinkSync(path.join(loop, "again"));
  fs.symlinkSync("again", path.join(loop, "again"));
  assert.throws(
    () => plan(workspace, source, { copy: ["loop"], install: [], trust: { direnv: false, mise: false } }),
    (err) => {
      assert.ok(err instanceof SetupError);
      assert.equal(err.message, "refusing to follow directory symlink cycle: loop/again");
      return true;
    },
  );
});

test("directory symlinks inside the source copy as real files under both names", (t) => {
  const { source, workspace } = roots(t);
  fs.mkdirSync(path.join(source, "real"));
  fs.writeFileSync(path.join(source, "real", "a"), "a\n");
  fs.symlinkSync("real", path.join(source, "alias"));
  fs.mkdirSync(path.join(source, "box"));
  fs.symlinkSync(path.join("..", "real"), path.join(source, "box", "one"));
  fs.symlinkSync(path.join("..", "real"), path.join(source, "box", "two"));
  const planned = plan(workspace, source, {
    copy: ["alias", "box"],
    install: [],
    trust: { direnv: false, mise: false },
  });
  assert.deepEqual(
    planned.copies.map((item) => [item.rel, item.action]),
    [
      ["alias/a", "copy"],
      ["box/one/a", "copy"],
      ["box/two/a", "copy"],
    ],
  );
});

test("a file symlink inside a directory stays a listed file", (t) => {
  const { dir, source, workspace } = roots(t);
  const outside = path.join(dir, "secret");
  fs.writeFileSync(outside, "from-outside\n");
  fs.mkdirSync(path.join(source, "secrets"));
  fs.symlinkSync(outside, path.join(source, "secrets", "token"));
  const planned = plan(workspace, source, {
    copy: ["secrets"],
    install: [],
    trust: { direnv: false, mise: false },
  });
  assert.deepEqual(planned.copies.map((item) => [item.rel, item.action]), [["secrets/token", "copy"]]);
});

test("lockfile detection reads the workspace, and skip-install hides the command", (t) => {
  const { source, workspace } = roots(t);
  fs.writeFileSync(path.join(source, "package-lock.json"), "");
  fs.writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "");
  const detected = plan(workspace, source, { copy: [] });
  assert.deepEqual(detected.install.commands, ["pnpm install --frozen-lockfile"]);
  assert.equal(detected.install.lockfile, "pnpm-lock.yaml");
  assert.match(formatReport(detected), /trust and install run again on every apply/);

  const skipped = plan(workspace, source, { copy: [] }, { skipInstall: true });
  assert.deepEqual(skipped.install.commands, []);
  assert.equal(skipped.install.reason, "--skip-install");
  const report = formatReport(skipped);
  assert.match(report, /install:\n {2}skipped {2}--skip-install/);
  assert.doesNotMatch(report, /pnpm install/);
});

test("trust counts a config this run will copy", (t) => {
  const { source, workspace } = roots(t);
  fs.writeFileSync(path.join(source, ".envrc"), "export FOO=1\n");
  fs.mkdirSync(path.join(source, ".mise"));
  fs.writeFileSync(path.join(source, ".mise", "config.toml"), "");
  const planned = plan(workspace, source, { copy: [".envrc", ".mise"], install: [] });
  assert.equal(planned.trust[0].action, "run");
  assert.equal(planned.trust[0].command, "direnv allow");
  assert.equal(planned.trust[1].action, "run");
  assert.equal(planned.trust[1].config, ".mise/config.toml");

  const held = plan(workspace, source, { copy: [".envrc", ".mise"], install: [] }, { skipTrust: true });
  assert.equal(held.trust[0].reason, "--skip-trust");
  assert.equal(held.trust[1].reason, "--skip-trust");
});

test("defaults report absent optional files and no install", (t) => {
  const { source, workspace } = roots(t);
  const loaded = loadConfig(workspace);
  const planned = planSetup({
    workspace,
    source,
    config: loaded.config,
    configPath: loaded.configPath,
    origin: loaded.origin,
  });
  const report = formatReport(planned);
  assert.match(report, /\(defaults\)/);
  assert.match(report, /\.env {2}absent/);
  assert.match(report, /\(none\) {2}no lockfile/);
  assert.match(report, /direnv {2}skip {2}no \.envrc/);
  assert.match(report, /mise {2}skip {2}no mise config/);
});
