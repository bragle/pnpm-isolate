# pnpm-isolate

`pnpm-isolate` reduces a pnpm workspace to just the package you want to build and the workspace packages it depends on.

It is mainly meant for temporary build steps, especially Docker.

By default it rewrites both `pnpm-lock.yaml` and `pnpm-workspace.yaml`.

## Usage

Usually you run it with `npx`:

```bash
npx pnpm-isolate <selector...> [options]
```

Examples:

```bash
npx pnpm-isolate ./app
npx pnpm-isolate @scope/app
npx pnpm-isolate ./app ./common
npx pnpm-isolate ./app --prod
npx pnpm-isolate ./app --dry-run
npx pnpm-isolate ./app --output pnpm-lock.isolated.yaml --workspace-output pnpm-workspace.isolated.yaml
```

## What it does

* keeps the selected workspace package
* keeps any workspace packages it depends on
* rewrites `pnpm-lock.yaml`
* rewrites `pnpm-workspace.yaml` by default
* can keep or drop the root importer (`.`)
* can strip importer `devDependencies`

## Options

```bash
--root <path>                 Workspace root directory. Default: nearest pnpm workspace
--output, -o <path>           Output lockfile path. Default: pnpm-lock.yaml
--workspace-output, -w <path> Output workspace manifest path. Default: pnpm-workspace.yaml
--no-prune-workspace          Do not rewrite pnpm-workspace.yaml
--no-keep-root                Do not keep the root importer (`.`)
--prod, -p                    Keep only production importer dependencies
--dry-run                     Show what would be kept without writing files
--help                        Show help
```

## Selectors

Use path selectors like `./app` when you mean a workspace path.

Package selectors also work, for example `@scope/app`.

If a selector does not already contain `...`, `pnpm-isolate` adds it automatically so dependencies are included.

## Typical flow

```bash
npx pnpm-isolate ./app
pnpm install --frozen-lockfile
pnpm --filter ./app build
```

If you want to inspect the result first:

```bash
npx pnpm-isolate ./app --dry-run
```

Or write to separate files:

```bash
npx pnpm-isolate ./app --output pnpm-lock.isolated.yaml --workspace-output pnpm-workspace.isolated.yaml
```

## Important

This tool is meant for temporary build steps.

It rewrites your workspace files by default. If that is not what you want, use `--no-prune-workspace` and or write to
separate output files first.
