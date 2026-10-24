import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCKFILES, detectInstall, normalizeConfig, planSetup } from "../src/index.js";

function workspaceWith(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of files) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
  return dir;
}

test("lockfile detection maps each known filename to one install command", (t) => {
  for (const entry of LOCKFILES) {
    const dir = workspaceWith(t, [entry.file]);
    const detected = detectInstall(dir);
    assert.equal(detected.manager, entry.manager);
    assert.equal(detected.lockfile, entry.file);
    assert.deepEqual(detected.commands, [entry.command]);
  }
});

test("pnpm, bun, and yarn win over a coexisting package-lock.json", (t) => {
  const cases = [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
  ];
  for (const [file, command] of cases) {
    const dir = workspaceWith(t, [file, "package-lock.json"]);
    assert.deepEqual(detectInstall(dir).commands, [command]);
  }
  const bunFirst = workspaceWith(t, ["bun.lock", "bun.lockb"]);
  assert.equal(detectInstall(bunFirst).lockfile, "bun.lock");
});

test("no lockfile detects nothing", (t) => {
  const dir = workspaceWith(t, ["package.json"]);
  assert.deepEqual(detectInstall(dir), { manager: null, lockfile: null, commands: [] });
});

test("an explicit install array replaces lockfile detection", (t) => {
  const dir = workspaceWith(t, ["pnpm-lock.yaml"]);
  const plan = planSetup({
    workspace: dir,
    source: dir,
    config: normalizeConfig({ copy: [], install: ["echo ready"] }),
    configPath: path.join(dir, ".layerfs", "setup.json"),
    origin: "file",
  });
  assert.deepEqual(plan.install.commands, ["echo ready"]);
  assert.equal(plan.install.lockfile, null);

  const empty = planSetup({
    workspace: dir,
    source: dir,
    config: normalizeConfig({ copy: [], install: [] }),
    configPath: plan.configPath,
    origin: "file",
  });
  assert.deepEqual(empty.install.commands, []);
  assert.equal(empty.install.reason, "install is empty");
});
