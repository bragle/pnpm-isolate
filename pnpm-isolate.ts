#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { dump } from 'js-yaml';

import { findWorkspaceDir } from '@pnpm/find-workspace-dir';
import {
	
	type LockfileObject,
	type ProjectId,
	type ProjectSnapshot,
	readWantedLockfile,
	writeWantedLockfile

} from '@pnpm/lockfile.fs';
import { pruneSharedLockfile } from '@pnpm/lockfile.pruner';
import { filterProjectsFromDir } from '@pnpm/workspace.projects-filter';
import { readWorkspaceManifest, type WorkspaceManifest } from '@pnpm/workspace.read-manifest';


interface Options {

	workspaceRoot: string;
	lockfileOutputPath: string;
	workspaceOutputPath: string;
	keepRootImporter: boolean;
	pruneWorkspaceManifest: boolean;
	productionOnly: boolean;
	dryRun: boolean;
	selectors: string[];

}

const main = async (): Promise<void> => {

	const options = await parseCommandLineArguments(process.argv.slice(2));

	const manifest = await readWorkspaceManifest(options.workspaceRoot);

	if (!manifest) throw Error(`No pnpm-workspace.yaml file was found in ${options.workspaceRoot}`);

	const lockfile = await readWantedLockfile(options.workspaceRoot, { ignoreIncompatible: false });

	if (!lockfile) throw Error(`No pnpm-lock.yaml file was found in ${options.workspaceRoot}`);

	const filter = options.selectors.map(selector => ({

		filter: expandSelector(selector),
		followProdDepsOnly: options.productionOnly

	}));

	const filterResults = await filterProjectsFromDir(options.workspaceRoot, filter, {

		patterns: manifest.packages,
		workspaceDir: options.workspaceRoot,
		prefix: options.workspaceRoot,
		linkWorkspacePackages: true,
		sharedWorkspaceLockfile: true,
		useGlobDirFiltering: false

	});

	const importerIds = new Set<string>(Object.keys(filterResults.selectedProjectsGraph).map(projectDirectory => {
		
		return createImporterId(options.workspaceRoot, projectDirectory);
	
	}));

	if (options.keepRootImporter && lockfile.importers['.' as ProjectId]) {

		importerIds.add('.');

	}

	if (!importerIds.size) {

		throw Error(`None of the selectors matched any workspace projects: ${options.selectors.join(', ')}`);

	}

	const prunedLockfile = createPrunedLockfile(lockfile, importerIds, options);
	const prunedWorkspaceManifest = options.pruneWorkspaceManifest
		? createPrunedWorkspaceManifest(manifest, importerIds)
		: manifest;

	const summary = createSummary(options, importerIds);

	if (options.dryRun) {

		process.stdout.write(`${summary}\n`);

		return;

	}

	await writeLockfile(prunedLockfile, options);

	if (options.pruneWorkspaceManifest) {

		await writeYamlFile(options.workspaceOutputPath, prunedWorkspaceManifest);

	}

	process.stdout.write(`${summary}\n`);

};

const parseCommandLineArguments = async (argumentList: string[]): Promise<Options> => {

	const selectors: string[] = [];

	let workspaceRoot: string | undefined;
	let lockfileOutputPath = 'pnpm-lock.yaml';
	let workspaceOutputPath = 'pnpm-workspace.yaml';
	let keepRootImporter = true;
	let pruneWorkspaceManifest = true;
	let productionOnly = false;
	let dryRun = false;

	for (let index = 0; index < argumentList.length; index += 1) {

		const argument = argumentList[index];

		switch (argument) {

			case '--help':
			case '-h':

				printHelp();

				process.exit(0);

			case '--root': {

				workspaceRoot = readRequiredArgumentValue(argumentList, index, '--root');

				index += 1;

				break;

			}

			case '--output':
			case '-o':

				lockfileOutputPath = readRequiredArgumentValue(argumentList, index, '--output');

				index += 1;

				break;

			case '--workspace-output':
			case '-w':

				workspaceOutputPath = readRequiredArgumentValue(argumentList, index, '--workspace-output');

				index += 1;

				break;

			case '--no-keep-root':

				keepRootImporter = false;

				break;

			case '--no-prune-workspace':

				pruneWorkspaceManifest = false;

				break;

			case '--prod':
			case '-p':

				productionOnly = true;

				break;


			case '--dry-run':

				dryRun = true;

				break;

			default:

				if (argument.startsWith('-')) throw Error(`Unknown argument: ${argument}`);

				selectors.push(argument);

				break;

		}

	}

	if (!selectors.length) throw Error('At least one workspace selector must be provided. Example: pnpm-isolate ./app');

	const resolvedWorkspaceRoot = await resolveWorkspaceRoot(workspaceRoot);

	return {

		workspaceRoot: resolvedWorkspaceRoot,

		lockfileOutputPath: path.resolve(resolvedWorkspaceRoot, lockfileOutputPath),
		workspaceOutputPath: path.resolve(resolvedWorkspaceRoot, workspaceOutputPath),

		keepRootImporter,
		pruneWorkspaceManifest,
		productionOnly,
		dryRun,
		selectors

	};

};

const readRequiredArgumentValue = (argumentList: string[], index: number, flagName: string): string => {

	const value = argumentList[index + 1];

	if (!value || value.startsWith('-')) throw Error(`Expected a value after ${flagName}`);

	return value;

};

const printHelp = (): void => {

	const helpText = [

		'pnpm-isolate',
		'',
		'Prunes pnpm-lock.yaml and pnpm-workspace.yaml to a selected workspace subset.',
		'',
		'Usage:',
		'  pnpm-isolate <selector...> [options]',
		'',
		'Selectors are interpreted like pnpm filters, but when they do not already',
		'contain an ellipsis, this tool automatically adds one so dependencies are kept.',
		'',
		'Examples:',
		'  pnpm-isolate ./app',
		'  pnpm-isolate @scope/app',
		'  pnpm-isolate ./packages/app',
		'  pnpm-isolate ./app ./.shared --output pnpm-lock.focused.yaml',
		'',
		'Options:',
		'  --root <path>                 Workspace root directory. Default: nearest pnpm workspace',
		'  --output, -o <path>           Output lockfile path. Default: pnpm-lock.yaml',
		'  --workspace-output, -w <path> Output workspace manifest path. Default: pnpm-workspace.yaml',
		'  --no-prune-workspace          Do not rewrite pnpm-workspace.yaml',
		'  --no-keep-root                Do not keep the root importer (.)',
		'  --prod, -p                    Keep only production importer dependencies',
		'  --dry-run                     Show what would be kept without writing files',
		'  --help                        Show this help text'

	].join('\n');

	process.stdout.write(`${helpText}\n`);

};

const resolveWorkspaceRoot = async (workspaceRootFromArguments: string | undefined): Promise<string> => {

	if (workspaceRootFromArguments != null) return path.resolve(workspaceRootFromArguments);

	const workspaceRoot = await findWorkspaceDir(process.cwd());

	if (!workspaceRoot) throw Error('Could not find a pnpm workspace root. Pass --root if needed.');

	return workspaceRoot;

};

const expandSelector = (selector: string): string => {

	if (selector.includes('...')) return selector;

	if (path.isAbsolute(selector) || selector.startsWith('.')) return `{${selector.replace(/\\/g, '/')}}...`;

	return `${selector}...`;

};

const createImporterId = (workspaceRoot: string, projectDirectory: string): string => {

	const relativePath = path.relative(workspaceRoot, projectDirectory);

	return relativePath ? relativePath.split(path.sep).join('/') : '.';

};

const createPrunedLockfile = (lockfile: LockfileObject, importerIds: Set<string>, options: Options): LockfileObject => {

	const importers: Record<ProjectId, ProjectSnapshot> = {};

	for (const importerId of importerIds) {

		const importer = lockfile.importers[importerId as ProjectId];
		
		if (!importer) throw Error(`Importer "${importerId}" was selected but not found in pnpm-lock.yaml`);

		if (options.productionOnly) {

			const { devDependencies: _devDependencies, ...rest } = importer;

			importers[importerId as ProjectId] = rest;

		} else {

			importers[importerId as ProjectId] = importer;

		}

	}

	return pruneSharedLockfile({ ...lockfile, importers });

};

const createPrunedWorkspaceManifest = (manifest: WorkspaceManifest, importerIds: Set<string>): WorkspaceManifest => {

	return {

		...manifest,
		packages: [ ...importerIds ].filter(importerId => importerId !== '.').sort((a, b) => a.localeCompare(b))

	};

};

const writeLockfile = async (lockfile: LockfileObject, options: Options): Promise<void> => {

	const normalizedWorkspaceLockfilePath = path.resolve(options.workspaceRoot, 'pnpm-lock.yaml');
	const normalizedOutputPath = path.resolve(options.lockfileOutputPath);

	if (normalizedOutputPath === normalizedWorkspaceLockfilePath) {

		await fs.mkdir(path.dirname(options.lockfileOutputPath), { recursive: true });

		await writeWantedLockfile(path.dirname(options.lockfileOutputPath), lockfile);

		return;

	}

	await writeYamlFile(options.lockfileOutputPath, lockfile);

};

const createSummary = (options: Options, importerIds: Set<string>): string => {

	const keptImporters = [ ...importerIds ].sort((a, b) => a.localeCompare(b));

	const relativeLockfilePath =
		path.relative(options.workspaceRoot, options.lockfileOutputPath) ||
		path.basename(options.lockfileOutputPath);

	const lines = [

		`Workspace root: ${options.workspaceRoot}`,
		`Selectors: ${options.selectors.join(', ')}`,
		`Mode: ${options.productionOnly ? 'production dependencies only' : 'all dependencies'}`,
		`Kept importers (${keptImporters.length}): ${keptImporters.join(', ')}`,
		`Lockfile output: ${relativeLockfilePath}`

	];

	if (options.pruneWorkspaceManifest) {

		const relativeWorkspacePath =
			path.relative(options.workspaceRoot, options.workspaceOutputPath) ||
			path.basename(options.workspaceOutputPath);

		lines.push(`Workspace output: ${relativeWorkspacePath}`);

	}

	return lines.join('\n');

};

const writeYamlFile = async (filePath: string, value: unknown): Promise<void> => {

	await fs.mkdir(path.dirname(filePath), { recursive: true });

	const serializedValue = dump(value, { lineWidth: 120, noRefs: true, sortKeys: false });
	const temporaryFilePath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

	await fs.writeFile(temporaryFilePath, serializedValue, 'utf8');
	await fs.rename(temporaryFilePath, filePath);

};

void main().catch((error: unknown) => {

	const message = error instanceof Error ? error.stack ?? error.message : String(error);

	process.stderr.write(`${message}\n`);
	process.exitCode = 1;

});
