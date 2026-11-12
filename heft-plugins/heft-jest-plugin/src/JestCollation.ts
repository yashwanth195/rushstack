// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  IShardCollationAdapter,
  IShardCollationContext,
  IShardCollationSession,
  IShardCollationVerdict
} from '@rushstack/heft/lib/sharding/IShardCollationAdapter';
import type { IShardCollationResult } from '@rushstack/heft/lib/sharding/ShardCollation';
import {
  invalidateShardFileAsync,
  validateShardPathAsync,
  writeShardFileAtomicallyAsync
} from '@rushstack/heft/lib/sharding/ShardFileSystem';
import { SHARD_MANIFEST_FILENAME } from '@rushstack/heft/lib/sharding/ShardResultManifest';
import { FileSystem, Path } from '@rushstack/node-core-library';
import type { ITerminal } from '@rushstack/terminal';
import {
  acquireShardOutputLocksAsync,
  releaseShardOutputLocks,
  resolveShardOutputPathAsync,
  resolveShardPathAsync,
  type IShardOutputLock,
  type IShardOutputOwner
} from '@rushstack/heft/lib/sharding/ShardOutputOwnership';

import {
  validateJestShardManifest,
  type IJestShardPayload,
  type IJestShardTestFile,
  type JestShardFailureReason
} from './JestShardPayload';
import { mergeJestCoverage } from './JestCoverage';
import {
  invalidateCoverageReportsAsync,
  writeCoverageReportsAsync,
  type IJestCoverageReport
} from './JestCoverageReporting';
import { serializeJestJUnitReport } from './JestJUnitReporting';

export interface IJestCollatorOptions {
  /** Build-root-relative report folder. Defaults to "temp". */
  outputDirectory?: string;
  /** A single JSON filename within outputDirectory. Defaults to "jest-collated.json". */
  reportFilename?: string;
  /** Optional build-root-relative JUnit XML filename. Only the collator writes this report. */
  junitOutputFile?: string;
}

export interface IJestCollatedCounts {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  failedSuites: number;
  runtimeErrorSuites: number;
}

export interface IJestCollatedShard {
  shardIndex: number;
  startedAt: string;
  durationMs: number;
  itemCount: number;
  diagnosticCount: number;
  failureReasons: JestShardFailureReason[];
}

/** Portable result report, not Jest's machine-specific AggregatedResult or --json format. */
export interface IJestCollatedReport {
  version: 3;
  workload: 'jest';
  generation: string;
  shardCount: number;
  passWithNoTests: boolean;
  success: boolean;
  itemCount: number;
  diagnosticCount: number;
  totals: IJestCollatedCounts;
  snapshotFailure: boolean;
  testFiles: IJestShardTestFile[];
  shards: IJestCollatedShard[];
  coverage: IJestCoverageReport;
}

/** Requires a coherent set from the neutral loader; independently validates every Jest payload. */
export function mergeJestShardResults(result: IShardCollationResult): IJestCollatedReport {
  const identities: Set<string> = new Set();
  const testFiles: IJestShardTestFile[] = [];
  const shards: IJestCollatedShard[] = [];
  const totals: IJestCollatedCounts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    failedSuites: 0,
    runtimeErrorSuites: 0
  };
  let snapshotFailure: boolean = false;
  let passWithNoTests: boolean | undefined;
  for (const manifest of result.manifests) {
    const payload: IJestShardPayload = validateJestShardManifest(manifest, identities);
    if (passWithNoTests === undefined) {
      passWithNoTests = payload.passWithNoTests;
    } else if (passWithNoTests !== payload.passWithNoTests) {
      throw new Error('Jest shards disagree about the configured passWithNoTests policy.');
    }
    totals.passed += payload.passed;
    totals.failed += payload.failed;
    totals.skipped += payload.skipped;
    totals.todo += payload.todo;
    totals.failedSuites += payload.failedSuites;
    totals.runtimeErrorSuites += payload.runtimeErrorSuites;
    snapshotFailure ||= payload.snapshotFailure;
    for (const file of payload.testFiles) testFiles.push(file);
    shards.push({
      shardIndex: manifest.shardIndex,
      startedAt: manifest.startedAt,
      durationMs: manifest.durationMs,
      itemCount: manifest.itemCount,
      diagnosticCount: manifest.diagnosticCount,
      failureReasons: payload.failureReasons
    });
  }
  for (const count of Object.values(totals)) {
    if (!Number.isSafeInteger(count))
      throw new Error('Combined Jest counters exceed the safe integer range.');
  }
  testFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const emptySuiteFailure: boolean = testFiles.length === 0 && !passWithNoTests;
  const diagnosticCount: number = result.diagnosticCount + (emptySuiteFailure ? 1 : 0);
  if (!Number.isSafeInteger(diagnosticCount)) {
    throw new Error('Combined Jest diagnostic count exceeds the safe integer range.');
  }
  return {
    version: 3,
    workload: 'jest',
    generation: result.generation,
    shardCount: result.manifests.length,
    passWithNoTests: passWithNoTests!,
    success: result.passed && !emptySuiteFailure,
    itemCount: result.itemCount,
    diagnosticCount,
    totals,
    snapshotFailure,
    testFiles,
    shards,
    coverage: {
      version: 1,
      configuration: (result.manifests[0].payload as IJestShardPayload).coverage.configuration,
      files: [],
      messages: []
    }
  };
}

export class JestCollationAdapter implements IShardCollationAdapter {
  private _reportPath: string;
  private _coverageFolderPath: string;
  private _junitPath: string | undefined;
  private readonly _buildFolderPath: string;
  private readonly _terminal: ITerminal;
  private readonly _owner: IShardOutputOwner;

  public constructor(
    buildFolderPath: string,
    terminal: ITerminal,
    options: IJestCollatorOptions = {},
    owner: IShardOutputOwner = {}
  ) {
    this._buildFolderPath = buildFolderPath;
    this._terminal = terminal;
    this._owner = owner;
    const outputDirectory: string = options.outputDirectory ?? 'temp';
    const reportFilename: string = options.reportFilename ?? 'jest-collated.json';
    if (
      !outputDirectory.trim() ||
      path.posix.isAbsolute(outputDirectory) ||
      path.win32.isAbsolute(outputDirectory)
    ) {
      throw new Error('Jest collator outputDirectory must be a nonempty build-root-relative folder.');
    }
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(reportFilename) ||
      reportFilename.toLowerCase() === SHARD_MANIFEST_FILENAME
    ) {
      throw new Error('Jest collator reportFilename must be a single JSON filename, not a shard manifest.');
    }
    this._reportPath = path.resolve(buildFolderPath, outputDirectory, reportFilename);
    this._coverageFolderPath = path.join(
      path.dirname(this._reportPath),
      `${path.basename(reportFilename, '.json')}-coverage`
    );
    if (options.junitOutputFile !== undefined) {
      if (
        !options.junitOutputFile.trim() ||
        path.posix.isAbsolute(options.junitOutputFile) ||
        path.win32.isAbsolute(options.junitOutputFile) ||
        options.junitOutputFile.includes(':') ||
        !/\.xml$/i.test(options.junitOutputFile)
      ) {
        throw new Error('Jest collator junitOutputFile must be a build-root-relative XML filename.');
      }
      this._junitPath = path.resolve(buildFolderPath, options.junitOutputFile);
    }
  }

  public async acquireAsync(context: IShardCollationContext): Promise<IShardCollationSession> {
    await this._validateDestinationsAsync(context);
    const realBuild: string = await fs.realpath(this._buildFolderPath);
    const owned: JestCollationAdapter = new JestCollationAdapter(realBuild, this._terminal);
    owned._reportPath = await resolveShardOutputPathAsync(this._buildFolderPath, this._reportPath, false);
    owned._coverageFolderPath = await resolveShardOutputPathAsync(
      this._buildFolderPath,
      this._coverageFolderPath,
      false
    );
    if (this._junitPath) {
      owned._junitPath = await resolveShardOutputPathAsync(this._buildFolderPath, this._junitPath, false);
    }
    const ownedContext: IShardCollationContext = {
      ...context,
      shardParentFolderPath: context.shardParentFolderPath
        ? await resolveShardPathAsync(context.shardParentFolderPath)
        : undefined
    };
    await owned._validateDestinationsAsync(ownedContext);
    const inventory: string = `${owned._coverageFolderPath}.files.json`;
    const canonicalInventory: string = await resolveShardPathAsync(inventory);
    // The content-bound coverage helper independently rejects file aliases. Claim both spellings
    // here so even a rejected attempt cannot invalidate a concurrent publisher's final report.
    const locks: IShardOutputLock[] = await acquireShardOutputLocksAsync(
      realBuild,
      [
        owned._reportPath,
        owned._coverageFolderPath,
        inventory,
        canonicalInventory,
        ...(owned._junitPath ? [owned._junitPath] : [])
      ],
      {
        project: path.basename(realBuild),
        ...this._owner,
        generation: context.expectedGeneration,
        shardCount: context.shardCount
      },
      context.abortSignal
    );
    let busy: boolean = false;
    const assertOwned = (): void => {
      if (locks.some((lock) => lock.isReleased))
        throw new Error('Jest collation ownership has been released.');
      if (busy) throw new Error('Jest collation session already has an active operation.');
    };
    const runAsync = async <T>(action: () => Promise<T>): Promise<T> => {
      assertOwned();
      busy = true;
      try {
        return await action();
      } finally {
        busy = false;
      }
    };
    return {
      prepareAsync: () => runAsync(() => owned._prepareAsync(ownedContext)),
      collateAsync: (result) => runAsync(() => owned._collateAsync(result, ownedContext, locks)),
      release: () => {
        assertOwned();
        releaseShardOutputLocks(locks);
      }
    };
  }

  /** Self-contained invalidation. Use acquireAsync() to retain ownership across several stages. */
  public async prepareAsync(context: IShardCollationContext): Promise<void> {
    const session: IShardCollationSession = await this.acquireAsync(context);
    try {
      await session.prepareAsync();
    } finally {
      session.release();
    }
  }

  /** Self-contained publication, including failure cleanup, for callers outside the neutral runner. */
  public async collateAsync(
    result: IShardCollationResult,
    context: IShardCollationContext
  ): Promise<IShardCollationVerdict> {
    const session: IShardCollationSession = await this.acquireAsync(context);
    let completed: boolean = false;
    try {
      const verdict: IShardCollationVerdict = await session.collateAsync(result);
      context.abortSignal.throwIfAborted();
      completed = true;
      return verdict;
    } finally {
      try {
        if (!completed) await session.prepareAsync();
      } finally {
        session.release();
      }
    }
  }

  private async _validateDestinationsAsync(context: IShardCollationContext): Promise<void> {
    const { shardParentFolderPath } = context;
    if (shardParentFolderPath) {
      await validateShardPathAsync(this._buildFolderPath, shardParentFolderPath);
    }
    const outputs: string[] = [
      this._reportPath,
      this._coverageFolderPath,
      `${this._coverageFolderPath}.files.json`,
      ...(this._junitPath ? [this._junitPath] : [])
    ];
    for (let index: number = 0; index < outputs.length; index++) {
      if (
        outputs
          .slice(index + 1)
          .some(
            (other) =>
              Path.isUnderOrEqual(outputs[index], other) || Path.isUnderOrEqual(other, outputs[index])
          )
      ) {
        throw new Error('Jest final report destinations must not overlap one another.');
      }
    }
    if (
      shardParentFolderPath &&
      outputs.some(
        (output) =>
          Path.isUnderOrEqual(output, shardParentFolderPath) ||
          Path.isUnderOrEqual(shardParentFolderPath, output)
      )
    ) {
      throw new Error('The Jest collated report must not overlap shard inputs.');
    }
    await this._validateReportPathAsync();
  }

  private async _prepareAsync(context: IShardCollationContext): Promise<void> {
    await this._validateDestinationsAsync(context);
    await invalidateShardFileAsync(this._reportPath);
    if (this._junitPath) await invalidateShardFileAsync(this._junitPath);
    await invalidateCoverageReportsAsync(this._buildFolderPath, this._coverageFolderPath, context);
    context.abortSignal.throwIfAborted();
  }

  private async _collateAsync(
    result: IShardCollationResult,
    { abortSignal }: IShardCollationContext,
    locks: readonly IShardOutputLock[]
  ): Promise<IShardCollationVerdict> {
    abortSignal.throwIfAborted();
    const report: IJestCollatedReport = mergeJestShardResults(result);
    report.coverage = await writeCoverageReportsAsync(
      this._buildFolderPath,
      this._coverageFolderPath,
      await mergeJestCoverage(
        result.manifests.map((manifest) => (manifest.payload as IJestShardPayload).coverage)
      ),
      abortSignal
    );
    report.diagnosticCount += report.coverage.messages.length;
    if (!Number.isSafeInteger(report.diagnosticCount)) {
      throw new Error('Combined Jest diagnostic count exceeds the safe integer range.');
    }
    report.success &&= report.coverage.messages.length === 0;
    await this._validateReportPathAsync(abortSignal);
    abortSignal.throwIfAborted();
    const commit = (action: () => void): void => {
      for (const lock of locks) lock.assertOwned();
      locks[0].commit(action);
    };
    if (this._junitPath) {
      await writeShardFileAtomicallyAsync(this._junitPath, serializeJestJUnitReport(report), abortSignal, {
        commit
      });
    }
    await writeShardFileAtomicallyAsync(this._reportPath, JSON.stringify(report), abortSignal, {
      commit
    });
    abortSignal.throwIfAborted();

    for (const message of report.coverage.messages) this._terminal.writeErrorLine(message);
    if (report.testFiles.length === 0 && !report.passWithNoTests) {
      this._terminal.writeErrorLine(
        'No Jest tests were selected. Configure passWithNoTests to allow an empty managed test run.'
      );
    }
    for (const file of report.testFiles) {
      if (file.failureMessage) {
        this._terminal.writeErrorLine(`${file.path}\n${file.failureMessage}`);
      }
      if (file.executionError && !file.failureMessage?.includes(file.executionError)) {
        this._terminal.writeErrorLine(`${file.path}\n${file.executionError}`);
      }
      for (const failure of file.failures) {
        for (const message of failure.messages) {
          if (!file.failureMessage?.includes(message)) {
            this._terminal.writeErrorLine(`${file.path}: ${failure.testName}\n${message}`);
          }
        }
      }
    }
    for (const shard of report.shards) {
      if (shard.failureReasons.length) {
        this._terminal.writeErrorLine(`Shard ${shard.shardIndex}: ${shard.failureReasons.join(', ')}`);
      }
    }
    const { passed, failed, skipped, todo, failedSuites, runtimeErrorSuites } = report.totals;
    this._terminal.writeLine(
      `Jest collated ${report.shardCount} shards: ${passed} passed, ${failed} failed, ${skipped} skipped, ${todo} todo; ` +
        `${report.testFiles.length} test files, ${failedSuites} failed suites, ${runtimeErrorSuites} execution errors.`
    );
    this._terminal.writeLine(`Jest report: ${path.relative(this._buildFolderPath, this._reportPath)}`);
    return { diagnosticCount: report.diagnosticCount };
  }

  private async _validateReportPathAsync(abortSignal?: AbortSignal): Promise<void> {
    for (const reportPath of [this._reportPath, ...(this._junitPath ? [this._junitPath] : [])]) {
      await validateShardPathAsync(this._buildFolderPath, reportPath, abortSignal);
      abortSignal?.throwIfAborted();
      try {
        if ((await fs.lstat(reportPath)).nlink > 1) {
          throw new Error('The Jest collated report must not be a hard link.');
        }
      } catch (error) {
        if (!FileSystem.isNotExistError(error as Error)) throw error;
      }
      abortSignal?.throwIfAborted();
    }
  }
}
