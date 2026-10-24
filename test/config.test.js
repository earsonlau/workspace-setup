import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_COPY,
  SetupError,
  loadConfig,
  normalizeConfig,
  starterConfig,
  writeStarter,
} from "../src/index.js";

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("missing config uses copy, install, and trust defaults", (t) => {
  const workspace = temp(t);
  const loaded = loadConfig(workspace);
  assert.equal(loaded.origin, "defaults");
  assert.deepEqual(loaded.config.copy, DEFAULT_COPY);
  assert.equal(loaded.config.install, null);
  assert.deepEqual(loaded.config.trust, { direnv: true, mise: true });
  assert.equal(loaded.configPath, path.join(workspace, ".layerfs", "setup.json"));
});

test("a partial file replaces copy and fills the other fields", (t) => {
  const workspace = temp(t);
  const configPath = path.join(workspace, ".layerfs", "setup.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ copy: [".env"], trust: { mise: false } }),
  );
  const loaded = loadConfig(workspace);
  assert.equal(loaded.origin, "file");
  assert.deepEqual(loaded.config.copy, [".env"]);
  assert.equal(loaded.config.install, null);
  assert.deepEqual(loaded.config.trust, { direnv: true, mise: false });
});

test("install null and an omitted install both mean detect", () => {
  assert.equal(normalizeConfig({ install: null }).install, null);
  assert.equal(normalizeConfig({}).install, null);
  assert.deepEqual(normalizeConfig({ install: [] }).install, []);
  assert.deepEqual(normalizeConfig({ install: ["npm run prepare"] }).install, ["npm run prepare"]);
});

test("relative copy paths are normalized and escapes are rejected", () => {
  assert.deepEqual(normalizeConfig({ copy: ["./env/../.env", "foo//bar"] }).copy, [".env", "foo/bar"]);
  assert.throws(() => normalizeConfig({ copy: ["../.env"] }), SetupError);
  assert.throws(() => normalizeConfig({ copy: ["/etc/passwd"] }), SetupError);
  assert.throws(() => normalizeConfig({ copy: ["foo/../../.env"] }), SetupError);
  assert.throws(() => normalizeConfig({ copy: [""] }), SetupError);
});

test("unknown keys do not fall back to default copy and install", () => {
  assert.throws(
    () => normalizeConfig({ copies: [".env"], installs: ["echo hi"], trusts: { direnv: false } }),
    (err) => {
      assert.ok(err instanceof SetupError);
      assert.match(err.message, /unknown field "copies", "installs", "trusts"/);
      return true;
    },
  );
  assert.throws(
    () => normalizeConfig({ copy: [".env"], extra: true }),
    /unknown field "extra"/,
  );
  assert.throws(
    () => normalizeConfig({ trust: { direnv: true, mise: false, allow: true } }),
    /trust: unknown field "allow"/,
  );
  const omitted = normalizeConfig({ copy: ["keep.txt"] });
  assert.deepEqual(omitted.copy, ["keep.txt"]);
  assert.equal(omitted.install, null);
});

test("invalid shapes name the field", () => {
  assert.throws(() => normalizeConfig([]), /JSON object/);
  assert.throws(() => normalizeConfig({ copy: ".env" }), /copy must be an array/);
  assert.throws(() => normalizeConfig({ install: "npm ci" }), /install must be an array/);
  assert.throws(() => normalizeConfig({ install: ["  "] }), /install\[0\]/);
  assert.throws(() => normalizeConfig({ trust: [] }), /trust must be an object/);
  assert.throws(() => normalizeConfig({ trust: { direnv: "yes" } }), /trust\.direnv/);
});

test("invalid JSON and a non-file config path fail clearly", (t) => {
  const workspace = temp(t);
  const configPath = path.join(workspace, ".layerfs", "setup.json");
  fs.mkdirSync(configPath, { recursive: true });
  assert.throws(() => loadConfig(workspace), /is not a file/);
  fs.rmSync(configPath, { recursive: true });
  fs.writeFileSync(configPath, "{");
  assert.throws(() => loadConfig(workspace), /setup\.json:/);
});

test("init writes the starter once and --force replaces it", (t) => {
  const dir = temp(t);
  const first = writeStarter(dir);
  assert.equal(first.written, true);
  assert.equal(first.reason, "wrote");
  const raw = fs.readFileSync(first.configPath, "utf8");
  assert.equal(raw, `${JSON.stringify(starterConfig(), null, 2)}\n`);
  const loaded = loadConfig(dir);
  assert.equal(loaded.config.install, null);

  const again = writeStarter(dir);
  assert.equal(again.written, false);
  assert.equal(again.reason, "already exists");

  fs.writeFileSync(first.configPath, "{}\n");
  const forced = writeStarter(dir, { force: true });
  assert.equal(forced.reason, "overwritten");
  assert.equal(fs.readFileSync(first.configPath, "utf8"), raw);

  const preview = writeStarter(dir, { dryRun: true });
  assert.equal(preview.written, false);
  assert.equal(preview.reason, "already exists");
  const forcedPreview = writeStarter(dir, { force: true, dryRun: true });
  assert.equal(forcedPreview.reason, "would overwrite");
  assert.equal(fs.readFileSync(first.configPath, "utf8"), raw);
  const probe = path.join(dir, ".probe-mode");
  fs.writeFileSync(probe, "x\n");
  assert.equal(fs.statSync(first.configPath).mode & 0o777, fs.statSync(probe).mode & 0o777);
  assert.deepEqual(fs.readdirSync(path.dirname(first.configPath)), ["setup.json"]);
});

test("init refuses a .layerfs symlink that leaves the project", (t) => {
  const dir = temp(t);
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const planted = path.join(outside, "setup.json");
  fs.writeFileSync(planted, "KEEP\n");
  fs.writeFileSync(path.join(outside, "other.txt"), "other\n");
  fs.symlinkSync(outside, path.join(project, ".layerfs"));

  for (const options of [{}, { force: true }, { dryRun: true }, { force: true, dryRun: true }]) {
    assert.throws(
      () => writeStarter(project, options),
      /refusing to write outside the workspace: \.layerfs\/setup\.json/,
    );
  }
  assert.equal(fs.readFileSync(planted, "utf8"), "KEEP\n");
  assert.deepEqual(fs.readdirSync(outside).sort(), ["other.txt", "setup.json"]);
  assert.equal(fs.lstatSync(path.join(project, ".layerfs")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(project, "setup.json")), false);

  const relative = path.join(dir, "relative");
  fs.mkdirSync(relative);
  const relativeOutside = path.join(dir, "relative-outside");
  fs.mkdirSync(relativeOutside);
  fs.symlinkSync(path.join("..", "relative-outside"), path.join(relative, ".layerfs"));
  assert.throws(
    () => writeStarter(relative, { force: true }),
    /refusing to write outside the workspace: \.layerfs\/setup\.json/,
  );
  assert.deepEqual(fs.readdirSync(relativeOutside), []);

  const cycled = path.join(dir, "cycled");
  fs.mkdirSync(cycled);
  fs.symlinkSync(".layerfs", path.join(cycled, ".layerfs"));
  assert.throws(
    () => writeStarter(cycled),
    /refusing to follow directory symlink cycle: \.layerfs\/setup\.json/,
  );
});

test("init writes through a .layerfs symlink that stays inside the project", (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, "real-layer"));
  fs.symlinkSync("real-layer", path.join(dir, ".layerfs"));
  const wrote = writeStarter(dir);
  assert.equal(wrote.written, true);
  const body = `${JSON.stringify(starterConfig(), null, 2)}\n`;
  assert.equal(fs.readFileSync(path.join(dir, "real-layer", "setup.json"), "utf8"), body);
  assert.equal(fs.lstatSync(path.join(dir, ".layerfs")).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "real-layer")), ["setup.json"]);
});

test("init does not follow a setup.json symlink or hard link", (t) => {
  const dir = temp(t);
  const layer = path.join(dir, ".layerfs");
  fs.mkdirSync(layer);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const linked = path.join(outside, "setup.json");
  fs.writeFileSync(linked, "KEEP\n");
  const configPath = path.join(layer, "setup.json");
  fs.symlinkSync(linked, configPath);

  const skipped = writeStarter(dir);
  assert.equal(skipped.reason, "already exists");
  assert.equal(fs.readFileSync(linked, "utf8"), "KEEP\n");
  assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);

  const preview = writeStarter(dir, { force: true, dryRun: true });
  assert.equal(preview.reason, "would overwrite");
  assert.equal(fs.readFileSync(linked, "utf8"), "KEEP\n");
  assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);

  const forced = writeStarter(dir, { force: true });
  assert.equal(forced.reason, "overwritten");
  assert.equal(fs.lstatSync(configPath).isSymbolicLink(), false);
  assert.match(fs.readFileSync(configPath, "utf8"), /"\.env"/);
  assert.equal(fs.readFileSync(linked, "utf8"), "KEEP\n");
  assert.deepEqual(fs.readdirSync(layer), ["setup.json"]);

  const danglingDir = path.join(dir, "dangling");
  fs.mkdirSync(path.join(danglingDir, ".layerfs"), { recursive: true });
  const danglingOutside = path.join(outside, "missing-setup.json");
  const danglingConfig = path.join(danglingDir, ".layerfs", "setup.json");
  fs.symlinkSync(danglingOutside, danglingConfig);
  assert.equal(writeStarter(danglingDir).reason, "already exists");
  assert.equal(fs.existsSync(danglingOutside), false);
  writeStarter(danglingDir, { force: true });
  assert.equal(fs.lstatSync(danglingConfig).isSymbolicLink(), false);
  assert.equal(fs.existsSync(danglingOutside), false);

  const hardDir = path.join(dir, "hard");
  fs.mkdirSync(path.join(hardDir, ".layerfs"), { recursive: true });
  const hardOutside = path.join(outside, "hard.json");
  fs.writeFileSync(hardOutside, "KEEP\n");
  const hardConfig = path.join(hardDir, ".layerfs", "setup.json");
  fs.linkSync(hardOutside, hardConfig);
  const outsideIno = fs.statSync(hardOutside).ino;
  writeStarter(hardDir, { force: true });
  assert.equal(fs.readFileSync(hardOutside, "utf8"), "KEEP\n");
  assert.equal(fs.statSync(hardOutside).ino, outsideIno);
  assert.notEqual(fs.statSync(hardConfig).ino, outsideIno);
  assert.match(fs.readFileSync(hardConfig, "utf8"), /"\.env"/);

  const dirConfig = path.join(dir, "blocked", ".layerfs", "setup.json");
  fs.mkdirSync(path.join(dirConfig, "keep"), { recursive: true });
  fs.writeFileSync(path.join(dirConfig, "keep", "note"), "x\n");
  assert.throws(() => writeStarter(path.join(dir, "blocked"), { force: true }), /is not a file/);
  assert.equal(fs.readFileSync(path.join(dirConfig, "keep", "note"), "utf8"), "x\n");
});

test("loadConfig refuses a config path that leaves the project", (t) => {
  const dir = temp(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const planted = path.join(outside, "setup.json");
  fs.writeFileSync(planted, "{");
  const escaped = path.join(dir, "escaped");
  fs.mkdirSync(escaped);
  fs.symlinkSync(outside, path.join(escaped, ".layerfs"));
  assert.throws(
    () => loadConfig(escaped),
    /refusing to write outside the workspace: \.layerfs\/setup\.json/,
  );
  assert.equal(fs.readFileSync(planted, "utf8"), "{");

  const emptyOutside = path.join(dir, "empty-outside");
  fs.mkdirSync(emptyOutside);
  const emptyProject = path.join(dir, "empty-project");
  fs.mkdirSync(emptyProject);
  fs.symlinkSync(emptyOutside, path.join(emptyProject, ".layerfs"));
  assert.throws(
    () => loadConfig(emptyProject),
    /refusing to write outside the workspace: \.layerfs\/setup\.json/,
  );
  assert.deepEqual(fs.readdirSync(emptyOutside), []);

  const leaf = path.join(dir, "leaf");
  fs.mkdirSync(path.join(leaf, ".layerfs"), { recursive: true });
  const leafOutside = path.join(outside, "leaf.json");
  fs.writeFileSync(leafOutside, JSON.stringify({ install: ["echo pwned"] }));
  fs.symlinkSync(leafOutside, path.join(leaf, ".layerfs", "setup.json"));
  assert.throws(
    () => loadConfig(leaf),
    /refusing to write outside the workspace: \.layerfs\/setup\.json/,
  );
  assert.equal(fs.readFileSync(leafOutside, "utf8"), JSON.stringify({ install: ["echo pwned"] }));

  const inside = path.join(dir, "inside");
  fs.mkdirSync(path.join(inside, "real"), { recursive: true });
  fs.writeFileSync(path.join(inside, "real", "setup.json"), JSON.stringify({ copy: ["keep.txt"] }));
  fs.symlinkSync("real", path.join(inside, ".layerfs"));
  assert.deepEqual(loadConfig(inside).config.copy, ["keep.txt"]);

  const linkedFile = path.join(dir, "linked-file");
  fs.mkdirSync(path.join(linkedFile, "real"), { recursive: true });
  fs.writeFileSync(
    path.join(linkedFile, "real", "setup.json"),
    JSON.stringify({ copy: [".env"] }),
  );
  fs.mkdirSync(path.join(linkedFile, ".layerfs"));
  fs.symlinkSync(
    path.join("..", "real", "setup.json"),
    path.join(linkedFile, ".layerfs", "setup.json"),
  );
  assert.deepEqual(loadConfig(linkedFile).config.copy, [".env"]);

  const notDir = path.join(dir, "not-dir");
  fs.mkdirSync(notDir);
  fs.writeFileSync(path.join(notDir, ".layerfs"), "not a directory\n");
  assert.equal(loadConfig(notDir).origin, "defaults");
  assert.equal(fs.readFileSync(path.join(notDir, ".layerfs"), "utf8"), "not a directory\n");
});
