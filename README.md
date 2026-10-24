# layerfs-workspace-setup

<p>
  <img src="logo.svg" alt="layerfs-workspace-setup" width="96" height="96">
</p>

One-shot bootstrap for a [LayerFS](https://layerfs.ai) Branch workspace. It copies an include-list of local files into the workspace, installs dependencies, and trusts direnv and mise.

A fresh workspace has the committed tree. Secrets and machine-local files such as `.env` stay in the checkout that created them. This plugin is the generic `.worktreeinclude` plus `setup.sh` for that gap. It talks to neither a LayerFS daemon nor a particular agent host.

Pinned LayerFS release: **v1.1.0** (`9f97a7ec95b662e9cb288704afa165feff132cfa`), recorded in [`layerfs.json`](layerfs.json).

## Install

Node.js 20 or newer. The package has no dependencies.

```bash
npm install
node bin/layerfs-workspace-setup.js --help
```

Install the command onto your `PATH` from a clone:

```bash
npm install --global .
layerfs-workspace-setup --help
```

After this repository is published, install it as a project dev dependency and run it with `npx layerfs-workspace-setup`.

## Quick start

Commit a config in the project (this is the file every new workspace already contains):

```bash
layerfs-workspace-setup init
```

That writes `.layerfs/setup.json`. Then, from a tree that holds the local files:

```bash
export LAYERFS_SETUP_FROM="$PRIMARY_CHECKOUT"
layerfs-workspace-setup check "$WORKSPACE"
layerfs-workspace-setup apply "$WORKSPACE"
```

Re-running `apply` leaves files that already exist in place unless you pass `--force`. Trust and install run again on every apply. Pass `--skip-trust` and `--skip-install` when a later run should only copy files that are still missing.

## Commands

```text
layerfs-workspace-setup apply [workspace]
layerfs-workspace-setup check [workspace]
layerfs-workspace-setup init [dir]
```

`workspace` and `dir` default to the current working directory.

| Flag | Effect |
| --- | --- |
| `--from <source>` | Directory that contains the files named in `copy`. Falls back to `$LAYERFS_SETUP_FROM`, then to the workspace itself. |
| `--force` | Overwrite workspace files that already exist. `init --force` rewrites an existing config. |
| `--dry-run` | Print the plan. Write nothing and run nothing. |
| `--skip-install` | Do not run install commands. |
| `--skip-trust` | Do not run `direnv allow` or `mise trust`. |
| `-h`, `--help` | Show help. |
| `--version` | Show the package version. |

`check` prints the same plan as `apply --dry-run` and always exits 0 when the config and both directories are valid. A listed file that is missing in the source is reported as `absent` and does not fail the command: the default names are optional.

Exit code 1 means a usage error, an invalid config, a missing directory, or a copy, trust, or install step that failed. Failures print `error: …` on stderr. Copy runs before trust and install, so a failed install leaves the copied files in place. Run `apply` again after fixing it.

## Config

Path: `.layerfs/setup.json` at the workspace root. A missing file selects the defaults below. The file is JSON.

```json
{
  "copy": [".env", ".env.local", ".npmrc", "certs/dev.pem"],
  "install": ["pnpm install --frozen-lockfile", "pnpm run prepare"],
  "trust": {
    "direnv": true,
    "mise": true
  }
}
```

| Field | Type | When omitted |
| --- | --- | --- |
| `copy` | Array of relative paths. Each entry is one file or a directory copied recursively. Globs are not expanded. | `[".env", ".env.local", ".npmrc"]` |
| `install` | Array of shell commands, run in order in the workspace through the system shell (`sh -c` on macOS and Linux). | Detect a lockfile (see below). `null` is the same as omitting the field. |
| `trust` | Object of booleans. | `{ "direnv": true, "mise": true }` |
| `trust.direnv` | Run `direnv allow` when `.envrc` is already in the workspace or this run will copy it there. | `true` |
| `trust.mise` | Run `mise trust` with `MISE_YES=1` when a mise config is already in the workspace or this run will copy it there. | `true` |

An explicit `copy` array replaces the default list. `"copy": []` copies nothing. An omitted `trust.direnv` or `trust.mise` stays `true`, so turn a tool off with `false`. Any other field is an error. A mistyped name such as `copies`, `installs`, or `trusts` does not fall back to these defaults, so it cannot copy `.env` or run install by accident.

`"install": []` runs nothing and does not look at lockfiles. Omit `install` to detect one command from the workspace (the tree you are setting up, where lockfiles are committed):

| First lockfile found | Command |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `bun.lock` | `bun install --frozen-lockfile` |
| `bun.lockb` | `bun install --frozen-lockfile` |
| `yarn.lock` | `yarn install --frozen-lockfile` |
| `package-lock.json` | `npm ci` |

`package-lock.json` is last so it does not hide another lockfile in the same tree. With no lockfile and no `install` array, the install step is skipped. Detection uses the filename only.

Paths in `copy` are relative. Absolute paths, null bytes, and any `..` that leaves the project are rejected. A symlink to a file is followed and written into the workspace as a regular file, so the secret is in the workspace even when the link target is not. A symlink to a directory is followed only when that target stays inside the source tree. A target outside the source is rejected, and a cycle is rejected with the path you wrote rather than an expanded chain. On the workspace side, a parent that is a symlink to a path outside the workspace is rejected before anything is written. `check`, `apply`, and `init` all fail in those cases. `init` refuses when `.layerfs` resolves outside the project, so it cannot create or replace `setup.json` there, including with `--force` or `--dry-run`. `check` and `apply` refuse to load a config whose real path is outside the project, whether `.layerfs` or `setup.json` itself is the link that leaves. An existing destination symlink is replaced only with `--force`. That write replaces the directory entry, so it does not follow the link, and a hard-linked destination is replaced with a new file so the other name keeps its old bytes. `init --force` does the same for `setup.json`. File mode bits are preserved (`0600` stays `0600`).

Trust looks at the workspace root:

| Tool | Config names |
| --- | --- |
| direnv | `.envrc` |
| mise | `mise.toml`, `.mise.toml`, `.mise/config.toml`, `.tool-versions` |

The first mise name that is present wins. One `mise trust` is enough. Install commands run in a non-interactive shell after trust, so they do not source `.envrc` themselves. Put an explicit command in `install` when the install needs the toolchain, for example `mise exec -- npm ci`.

`init` writes this starter, which keeps lockfile detection turned on:

```json
{
  "copy": [".env", ".env.local", ".npmrc"],
  "trust": {
    "direnv": true,
    "mise": true
  }
}
```

`init` does not overwrite that file unless you pass `--force`. A second `init` prints `skip` and exits 0. A `setup.json` that is itself a symlink is left in place unless you pass `--force`, which replaces the link with a regular file and does not write through it. If `.layerfs` points outside the project, `init` exits 1 and writes nothing.

## After a Branch is created

Run the CLI on a machine that can read both directories. `$WORKSPACE` is the workspace directory (`path` from `workspace.mount`, or any directory you just created). `$PRIMARY_CHECKOUT` is the tree that holds the untracked files.

```bash
export LAYERFS_SETUP_FROM="$PRIMARY_CHECKOUT"
layerfs-workspace-setup apply "$WORKSPACE"
```

From a shell whose current directory is already the workspace, including `workspace.exec`:

```bash
layerfs-workspace-setup apply --from /path/to/primary
```

```js
await layerfs.workspace.exec(
  ws,
  "layerfs-workspace-setup apply . --from /path/to/primary",
  "bootstrap workspace",
);
```

`--from` has to be a path that shell can read. Put `layerfs-workspace-setup` on `PATH` there first.

Wrapper you can call from your own Branch-create hook:

```bash
#!/bin/sh
set -eu
WORKSPACE=${1:-.}
SOURCE=${LAYERFS_SETUP_FROM:?set LAYERFS_SETUP_FROM to the checkout that holds local files}
exec layerfs-workspace-setup apply "$WORKSPACE" --from "$SOURCE"
```

How the usual two files map onto this config:

| Usual piece | Here |
| --- | --- |
| `.worktreeinclude` paths | `copy` |
| `setup.sh` install lines | `install`, or lockfile detection when `install` is omitted |
| `direnv allow` and `mise trust` | `trust` |

## Development

```bash
npm test
```

Tests use `node:test`. They build temporary directories on disk and do not need a LayerFS daemon, Docker, or network access.

## License

[MIT](LICENSE)
