import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN = "9f97a7ec95b662e9cb288704afa165feff132cfa";

test("package.json is the marketplace CLI package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "layerfs-workspace-setup");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["layerfs-workspace-setup"], "./bin/layerfs-workspace-setup.js");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.scripts.test, "node --test");
});

test("layerfs.json pins LayerFS v1.1.0 by commit", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "layerfs.json"), "utf8"));
  assert.equal(manifest.id, "layerfs-workspace-setup");
  assert.equal(manifest.name, "layerfs-workspace-setup");
  assert.equal(manifest.commit, PIN);
  assert.equal(manifest.layerfs.version, "1.1.0");
  assert.equal(manifest.layerfs.commit, PIN);
  assert.equal(manifest.layerfs.source, manifest.source);
  assert.match(manifest.bin, /layerfs-workspace-setup/);
});

test("README, license, and logo ship with the pin", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /v1\.1\.0/);
  assert.match(readme, new RegExp(PIN));
  assert.match(readme, /\.layerfs\/setup\.json/);
  assert.match(readme, /--from/);
  assert.match(readme, /Trust and install run again on every apply/);
  assert.match(readme, /does not fall back to these defaults/);
  assert.match(readme, /parent that is a symlink to a path outside the workspace/);
  assert.match(readme, /`init` refuses when `\.layerfs` resolves outside/);
  assert.match(readme, /workspace\.exec/);
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  assert.match(license, /MIT License/);
  const logo = fs.readFileSync(path.join(root, "logo.svg"), "utf8");
  assert.match(logo, /<svg/);
});
