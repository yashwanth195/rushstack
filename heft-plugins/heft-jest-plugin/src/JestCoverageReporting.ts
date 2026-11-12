// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { CoverageReporter, Config, AggregatedResult } from '@jest/reporters';
import { createEmptyTestResult, makeEmptyAggregatedTestResult } from '@jest/test-result';
import { readConfigs } from 'jest-config';
import { createCoverageMap, type CoverageMap, type FileCoverageData } from 'istanbul-lib-coverage';
import type { Context } from 'istanbul-lib-report';
import type { ReportOptions } from 'istanbul-reports';

import { FileSystem } from '@rushstack/node-core-library';
import type { IShardCollationContext } from '@rushstack/heft/lib/sharding/IShardCollationAdapter';
import { loadShardResultsAsync } from '@rushstack/heft/lib/sharding/ShardCollation';
import {
  invalidateShardFileAsync,
  validateShardPathAsync,
  writeShardFileAtomicallyAsync
} from '@rushstack/heft/lib/sharding/ShardFileSystem';

import {
  readCoverageSourceAsync,
  validateCoverageIdentity,
  type IJestCoverage,
  type ICoverageSource
} from './JestCoverage';
import { validateJestShardManifest } from './JestShardPayload';

export interface IJestCoverageReport {
  version: 1;
  configuration: IJestCoverage['configuration'];
  files: string[];
  messages: string[];
}

interface ICoverageOutputFile {
  path: string;
  sha256: string;
}

interface ICoverageOutputInventory {
  version: 1;
  files: ICoverageOutputFile[];
}

function recoveryError(message: string): Error {
  return new Error(
    `${message} Preserve any source or user data, then manually move conflicting files or remove only ` +
      'verified generated reports and their inventory before retrying.'
  );
}

async function validateOutputFileAsync(
  buildFolderPath: string,
  filename: string
): Promise<Stats | undefined> {
  await validateShardPathAsync(buildFolderPath, filename);
  const physicalBuildFolder: string = await fs.realpath(buildFolderPath);
  let existing: string = filename;
  for (;;) {
    try {
      const physical: string = await fs.realpath(existing);
      const expected: string = path.join(physicalBuildFolder, path.relative(buildFolderPath, existing));
      if (path.relative(physical, expected)) {
        throw recoveryError(`Coverage output must not use a filesystem alias: "${filename}".`);
      }
      break;
    } catch (error) {
      if (!FileSystem.isNotExistError(error as Error)) throw error;
      existing = path.dirname(existing);
    }
  }
  try {
    const stat: Stats = await fs.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Coverage output must be a regular file, not a directory or hard link: "${filename}".`);
    }
    return stat;
  } catch (error) {
    if (!FileSystem.isNotExistError(error as Error)) throw error;
  }
}

async function requireAbsentOutputAsync(buildFolderPath: string, filename: string): Promise<void> {
  if (await validateOutputFileAsync(buildFolderPath, filename)) {
    throw recoveryError(`Refusing to overwrite an unowned coverage output: "${filename}".`);
  }
}

async function hashFileAsync(filename: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filename))
    .digest('hex');
}

/** Content-bound ownership also permits cleanup of an interrupted publication's missing files. */
export async function invalidateCoverageReportsAsync(
  buildFolderPath: string,
  outputFolderPath: string,
  context: IShardCollationContext
): Promise<void> {
  await validateShardPathAsync(buildFolderPath, outputFolderPath);
  const inventoryPath: string = `${outputFolderPath}.files.json`;
  await validateOutputFileAsync(buildFolderPath, inventoryPath);
  let inventory: ICoverageOutputInventory;
  try {
    inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  } catch (error) {
    if (FileSystem.isNotExistError(error as Error)) return;
    throw recoveryError(`Cannot read the Jest coverage output inventory: "${inventoryPath}".`);
  }
  if (inventory?.version !== 1 || !Array.isArray(inventory.files)) {
    throw recoveryError(`Invalid or legacy Jest coverage output inventory: "${inventoryPath}".`);
  }
  const outputs: Set<string> = new Set([inventoryPath]);
  // Validate every record and every existing file before removing anything.
  for (const file of inventory.files) {
    if (
      typeof file?.path !== 'string' ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw recoveryError(`Invalid Jest coverage output inventory: "${inventoryPath}".`);
    }
    validateCoverageIdentity(file.path);
    const filename: string = path.join(outputFolderPath, file.path);
    if (outputs.has(filename)) {
      throw recoveryError(`Duplicate file in Jest coverage output inventory: "${inventoryPath}".`);
    }
    outputs.add(filename);
    if (
      (await validateOutputFileAsync(buildFolderPath, filename)) &&
      (await hashFileAsync(filename)) !== file.sha256
    ) {
      throw recoveryError(`Refusing to remove a modified coverage output: "${filename}".`);
    }
  }
  // A byte-identical generated script may now be an input. Ownership alone cannot authorize its deletion.
  await validateCleanupSourcesAsync(buildFolderPath, context, outputs);
  for (const file of inventory.files) {
    await invalidateShardFileAsync(path.join(outputFolderPath, file.path));
  }
  await invalidateShardFileAsync(inventoryPath);
}

async function validateCleanupSourcesAsync(
  buildFolderPath: string,
  { shardParentFolderPath, shardCount, expectedGeneration }: IShardCollationContext,
  outputs: ReadonlySet<string>
): Promise<void> {
  if (!shardParentFolderPath || shardCount === undefined) {
    throw recoveryError(
      'Cannot verify coverage sources before cleaning previous reports without the requested shard inputs and count.'
    );
  }
  await validateShardPathAsync(buildFolderPath, shardParentFolderPath);
  const hashes: Map<string, string> = new Map();
  const inputs: Set<string> = new Set();
  try {
    // Invalidation also runs after cancellation. Prove the entire current input set without
    // the aborted signal before authorizing any coverage deletion.
    const { manifests } = await loadShardResultsAsync({
      shardParentFolderPath,
      shardCount,
      expectedGeneration
    });
    for (const manifest of manifests) {
      const { coverage, testFiles } = validateJestShardManifest(manifest);
      for (const [identity, hash] of Object.entries(coverage.sourceHashes)) {
        const previous: string | undefined = hashes.get(identity);
        if (previous !== undefined && previous !== hash) throw new Error('Conflicting source hashes.');
        hashes.set(identity, hash);
        inputs.add(identity);
      }
      for (const script of coverage.v8 ?? []) inputs.add(script.result.url);
      for (const testFile of testFiles) inputs.add(testFile.path);
    }
  } catch (error) {
    throw recoveryError(
      `Cannot verify coverage sources before cleaning previous reports: ${(error as Error).message}`
    );
  }
  const physicalOutputs: Set<string> = new Set();
  for (const output of outputs) {
    try {
      physicalOutputs.add(await fs.realpath(output));
    } catch (error) {
      if (!FileSystem.isNotExistError(error as Error)) throw error;
    }
  }
  for (const identity of inputs) {
    const filename: string = path.resolve(buildFolderPath, identity);
    await validateShardPathAsync(buildFolderPath, filename);
    try {
      if (physicalOutputs.has(await fs.realpath(filename))) {
        throw recoveryError(
          `Refusing to remove a coverage source used by the current shards: "${identity}".`
        );
      }
    } catch (error) {
      if (!FileSystem.isNotExistError(error as Error)) throw error;
    }
  }
  for (const [identity, hash] of hashes) {
    const source: ICoverageSource = await readCoverageSourceAsync(buildFolderPath, identity);
    if (source.hash !== hash) {
      throw recoveryError(`Jest coverage source changed or does not match the cached shard: "${identity}".`);
    }
  }
}

async function listReportFilesAsync(folder: string, prefix: string = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const relative: string = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listReportFilesAsync(folder, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('Coverage reporters must produce only regular files.');
  }
  return files.sort();
}

/** Uses only the exported reporter lifecycle; never calls Jest's private _checkThreshold(). */
async function evaluateThresholdsAsync(
  buildFolderPath: string,
  coverage: IJestCoverage,
  map: CoverageMap
): Promise<string[]> {
  if (!coverage.configuration.thresholds) return [];
  const { CoverageReporter: CoverageReporterClass } = await import('@jest/reporters');
  const thresholds: NonNullable<Config.GlobalConfig['coverageThreshold']> = Object.create(null);
  for (const [name, threshold] of Object.entries(coverage.configuration.thresholds)) {
    thresholds[
      name === 'global' ? name : path.resolve(buildFolderPath, name) + (name.endsWith('/') ? path.sep : '')
    ] = threshold;
  }
  const { globalConfig } = await readConfigs(
    {
      $0: 'heft-jest-collator',
      _: [],
      config: JSON.stringify({
        rootDir: buildFolderPath,
        coverageThreshold: thresholds,
        coverageReporters: []
      }),
      // Inputs are already Istanbul maps, even when collected by V8.
      coverageProvider: 'babel',
      useStderr: true,
      runInBand: true
    },
    [buildFolderPath]
  );
  const reporter: CoverageReporter = new CoverageReporterClass(globalConfig, {
    firstRun: true,
    previousSuccess: true
  });
  const results: AggregatedResult = makeEmptyAggregatedTestResult();
  // The public CoverageReporter ignores its Test argument. No test context is needed to
  // consume a pre-merged Istanbul map; an empty context set also prevents recollection.
  reporter.onTestResult(undefined!, { ...createEmptyTestResult(), coverage: map.toJSON() });
  await reporter.onRunComplete(new Set(), results);
  if (!results.coverageMap) throw new Error('Jest coverage threshold evaluation did not complete.');
  return (
    reporter
      .getLastError()
      ?.message.split('\n')
      .map((message) => message.replaceAll(`${buildFolderPath}${path.sep}`, '').replaceAll('\\', '/')) ?? []
  );
}

export async function writeCoverageReportsAsync(
  buildFolderPath: string,
  outputFolderPath: string,
  coverage: IJestCoverage,
  abortSignal: AbortSignal
): Promise<IJestCoverageReport> {
  const report: IJestCoverageReport = {
    version: 1,
    configuration: coverage.configuration,
    files: [],
    messages: []
  };
  if (!coverage.configuration.enabled) return report;
  abortSignal.throwIfAborted();
  const [{ createContext }, { create }] = await Promise.all([
    import('istanbul-lib-report'),
    import('istanbul-reports')
  ]);
  const absoluteData: Record<string, FileCoverageData> = Object.create(null);
  const sources: Map<string, string> = new Map();
  for (const [identity, data] of Object.entries(coverage.map!)) {
    const source: ICoverageSource = await readCoverageSourceAsync(buildFolderPath, identity);
    if (source.hash !== coverage.sourceHashes[identity]) {
      throw new Error(`Jest coverage source changed or does not match the cached shard: "${identity}".`);
    }
    const filename: string = path.resolve(buildFolderPath, identity);
    absoluteData[filename] = { ...data, path: filename };
    sources.set(filename, source.text);
  }
  const map: CoverageMap = createCoverageMap(absoluteData);
  report.messages = await evaluateThresholdsAsync(buildFolderPath, coverage, map);
  await validateShardPathAsync(buildFolderPath, outputFolderPath, abortSignal);
  await fs.mkdir(path.dirname(outputFolderPath), { recursive: true });
  const staging: string = await fs.mkdtemp(path.join(path.dirname(outputFolderPath), '.jest-coverage-'));
  try {
    const context: Context = createContext({
      dir: staging,
      coverageMap: map,
      sourceFinder: (filename) => {
        const source: string | undefined = sources.get(filename);
        if (source === undefined) throw new Error(`Missing coverage report source "${filename}".`);
        return source;
      }
    });
    const reporters: Set<string> = new Set(coverage.configuration.reporters);
    reporters.add('json');
    if (!reporters.has('lcov')) reporters.add('lcovonly');
    for (const name of reporters) {
      abortSignal.throwIfAborted();
      // Builtin reporters only, without user-provided file/subdir redirects.
      create(name as keyof ReportOptions, {
        projectRoot: buildFolderPath,
        maxCols: process.stdout.columns || Number.POSITIVE_INFINITY
      }).execute(context);
    }
    const files: string[] = await listReportFilesAsync(staging);
    if (!files.includes('coverage-final.json') || !files.includes('lcov.info')) {
      throw new Error('Jest coverage reporters did not produce the required JSON and lcov reports.');
    }
    // Istanbul's JSON reporter emits absolute paths. The published JSON uses the validated portable map.
    await fs.writeFile(path.join(staging, 'coverage-final.json'), JSON.stringify(coverage.map));
    const inventoryPath: string = `${outputFolderPath}.files.json`;
    await requireAbsentOutputAsync(buildFolderPath, inventoryPath);
    const inventory: ICoverageOutputInventory = { version: 1, files: [] };
    for (const file of files) {
      validateCoverageIdentity(file);
      await requireAbsentOutputAsync(buildFolderPath, path.join(outputFolderPath, file));
      inventory.files.push({ path: file, sha256: await hashFileAsync(path.join(staging, file)) });
    }
    // Write the complete inventory before publishing any files, so a retry cleans partial output.
    await writeShardFileAtomicallyAsync(inventoryPath, JSON.stringify(inventory), abortSignal);
    for (const file of files) {
      abortSignal.throwIfAborted();
      const destination: string = path.join(outputFolderPath, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await requireAbsentOutputAsync(buildFolderPath, destination);
      await fs.rename(path.join(staging, file), destination);
      await validateOutputFileAsync(buildFolderPath, destination);
      report.files.push(path.relative(buildFolderPath, destination).split(path.sep).join('/'));
    }
    abortSignal.throwIfAborted();
    return report;
  } finally {
    // This exclusively-created staging directory contains only this attempt's builtin reporter output.
    await fs.rm(staging, { recursive: true, force: true });
  }
}
