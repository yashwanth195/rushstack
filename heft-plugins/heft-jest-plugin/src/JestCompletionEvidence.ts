// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { AggregatedResult, Config, Reporter, Test, TestResult } from '@jest/reporters';

import { FileSystem } from '@rushstack/node-core-library';
import { validateShardPathAsync } from '@rushstack/heft/lib/sharding/ShardFileSystem';

type CompletionStage = 'scheduled' | 'entered' | 'settled' | 'completed';
export type JestCompletionOutcome = 'returned' | 'threw';

interface ICompletionReceipt {
  version: 1;
  attempt: string;
  testPath: string;
  stage: CompletionStage;
  outcome?: JestCompletionOutcome;
  executionError?: string;
}

interface ICompletionEnvelope {
  payload: string;
  sha256: string;
}

interface IActiveCompletionAttempt {
  attempt: string;
  collector: JestCompletionCollector | undefined;
}

const COMPLETION_STAGES: readonly CompletionStage[] = ['scheduled', 'entered', 'settled', 'completed'];
const ACTIVE_ATTEMPTS: Map<string, IActiveCompletionAttempt> = new Map();

export function getCompletionAttempt(config: Config.ProjectConfig): string {
  const active: IActiveCompletionAttempt | undefined = ACTIVE_ATTEMPTS.get(
    getManagedJestExecutionKey(config.cacheDirectory)
  );
  if (!active) throw new Error('Missing managed Jest completion attempt.');
  return active.attempt;
}

export function registerManagedJestAttempt(
  cacheDirectory: string,
  attempt: string,
  collector?: JestCompletionCollector
): () => void {
  if (!/^[a-f0-9-]{36}$/.test(attempt)) throw new Error('Invalid managed Jest completion attempt.');
  const key: string = getManagedJestExecutionKey(cacheDirectory);
  if (ACTIVE_ATTEMPTS.has(key)) throw new Error('Duplicate managed Jest completion attempt.');
  const active: IActiveCompletionAttempt = { attempt, collector };
  ACTIVE_ATTEMPTS.set(key, active);
  let released: boolean = false;
  return () => {
    if (released) return;
    if (ACTIVE_ATTEMPTS.get(key) !== active) {
      throw new Error('Inconsistent managed Jest completion attempt.');
    }
    ACTIVE_ATTEMPTS.delete(key);
    released = true;
  };
}

export function getManagedJestExecutionKey(cacheDirectory: string): string {
  const resolved: string = path.resolve(cacheDirectory);
  return process.platform === 'win32' ? resolved.toUpperCase() : resolved;
}

export async function removeEmptyJestEvidenceDirectoryAsync(
  config: Config.ProjectConfig,
  directory: string
): Promise<void> {
  await validateShardPathAsync(config.rootDir, directory);
  try {
    await fs.rmdir(directory);
  } catch (error) {
    const code: string | undefined = (error as NodeJS.ErrnoException).code;
    if (
      code !== 'ENOENT' &&
      code !== 'ENOTEMPTY' &&
      code !== 'EEXIST' &&
      code !== 'EBUSY' &&
      code !== 'EPERM' &&
      code !== 'ENOTDIR'
    ) {
      throw error;
    }
  }
}

export function getCompletionReceiptPath(
  config: Config.ProjectConfig,
  testPath: string,
  stage: CompletionStage
): string {
  return path.join(
    config.cacheDirectory,
    'suite-completion',
    getCompletionAttempt(config),
    createHash('sha256').update(testPath).digest('hex'),
    `${stage}.json`
  );
}

async function writeReceiptAsync(
  config: Config.ProjectConfig,
  testPath: string,
  stage: CompletionStage,
  outcome?: JestCompletionOutcome,
  executionError?: string
): Promise<void> {
  const filename: string = getCompletionReceiptPath(config, testPath, stage);
  await validateShardPathAsync(config.rootDir, filename);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await validateShardPathAsync(config.rootDir, filename);
  const receipt: ICompletionReceipt = {
    version: 1,
    attempt: getCompletionAttempt(config),
    testPath,
    stage,
    outcome,
    executionError
  };
  const payload: string = JSON.stringify(receipt);
  const envelope: ICompletionEnvelope = {
    payload,
    sha256: createHash('sha256').update(payload).digest('hex')
  };
  // Immutable stages reject worker retries, rather than overwriting evidence of an abandoned invocation.
  await fs.writeFile(filename, JSON.stringify(envelope), { flag: 'wx' });
}

async function readReceiptAsync(
  config: Config.ProjectConfig,
  testPath: string,
  stage: CompletionStage
): Promise<ICompletionReceipt> {
  const filename: string = getCompletionReceiptPath(config, testPath, stage);
  await validateShardPathAsync(config.rootDir, filename);
  const stat: Stats = await fs.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid Jest completion receipt file.');
  const envelope: ICompletionEnvelope = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (
    !envelope ||
    typeof envelope.payload !== 'string' ||
    envelope.sha256 !== createHash('sha256').update(envelope.payload).digest('hex')
  ) {
    throw new Error('Corrupt Jest completion receipt.');
  }
  const receipt: ICompletionReceipt = JSON.parse(envelope.payload);
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.attempt !== getCompletionAttempt(config) ||
    receipt.testPath !== testPath ||
    receipt.stage !== stage ||
    (stage === 'settled' || stage === 'completed'
      ? receipt.outcome !== 'returned' && receipt.outcome !== 'threw'
      : receipt.outcome !== undefined || receipt.executionError !== undefined) ||
    (receipt.executionError !== undefined && !/^[a-f0-9]{64}$/.test(receipt.executionError)) ||
    (receipt.outcome === 'threw' && receipt.executionError === undefined)
  ) {
    throw new Error('Stale or inconsistent Jest completion receipt.');
  }
  return receipt;
}

export async function scheduleJestSuiteAsync(config: Config.ProjectConfig, testPath: string): Promise<void> {
  await writeReceiptAsync(config, testPath, 'scheduled');
}

export async function enterJestSuiteAsync(config: Config.ProjectConfig, testPath: string): Promise<void> {
  await readReceiptAsync(config, testPath, 'scheduled');
  await writeReceiptAsync(config, testPath, 'entered');
}

export async function settleJestSuiteAsync(
  config: Config.ProjectConfig,
  testPath: string,
  outcome: JestCompletionOutcome,
  testExecError: TestResult['testExecError']
): Promise<void> {
  await readReceiptAsync(config, testPath, 'entered');
  await writeReceiptAsync(config, testPath, 'settled', outcome, getExecutionErrorDigest(testExecError));
}

function getExecutionErrorDigest(error: TestResult['testExecError']): string | undefined {
  // Circus may return completed assertions plus an afterAll error. Bind that original error,
  // independently of whether Circus returned or rejected, across outer runtime teardown and IPC.
  return error
    ? createHash('sha256')
        .update(
          JSON.stringify({
            message: error.message,
            stack: error.stack,
            type: error.type
          })
        )
        .digest('hex')
    : undefined;
}

/** Only the public outer runner's success event may acknowledge environment/runtime teardown. */
export async function completeJestSuiteAsync(
  config: Config.ProjectConfig,
  result: TestResult
): Promise<JestCompletionOutcome> {
  const receipt: ICompletionReceipt = await readReceiptAsync(config, result.testFilePath, 'settled');
  if (result.leaks || receipt.executionError !== getExecutionErrorDigest(result.testExecError)) {
    throw new Error(`Inconsistent Jest runner completion for "${result.testFilePath}".`);
  }
  await writeReceiptAsync(config, result.testFilePath, 'completed', receipt.outcome, receipt.executionError);
  return receipt.outcome!;
}

export async function readJestSuiteCompletionAsync(
  config: Config.ProjectConfig,
  testPath: string
): Promise<JestCompletionOutcome> {
  await readReceiptAsync(config, testPath, 'scheduled');
  await readReceiptAsync(config, testPath, 'entered');
  const settled: ICompletionReceipt = await readReceiptAsync(config, testPath, 'settled');
  const completed: ICompletionReceipt = await readReceiptAsync(config, testPath, 'completed');
  if (completed.outcome !== settled.outcome || completed.executionError !== settled.executionError) {
    throw new Error('Inconsistent Jest completion outcomes.');
  }
  return completed.outcome!;
}

async function removeReceiptsAsync(config: Config.ProjectConfig, testPath: string): Promise<void> {
  let suiteDirectory: string | undefined;
  for (const stage of COMPLETION_STAGES) {
    const filename: string = getCompletionReceiptPath(config, testPath, stage);
    suiteDirectory ??= path.dirname(filename);
    await validateShardPathAsync(config.rootDir, filename);
    try {
      const stat: Stats = await fs.lstat(filename);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid Jest completion receipt file.');
      await fs.unlink(filename);
    } catch (error) {
      // A failed invocation may never reach later stages. Other cleanup errors must prevent publication.
      if (!FileSystem.isNotExistError(error as Error)) throw error;
    }
  }
  await removeEmptyJestEvidenceDirectoryAsync(config, suiteDirectory!);
  await removeEmptyJestEvidenceDirectoryAsync(config, path.dirname(suiteDirectory!));
}

export class JestCompletionCollector {
  public readonly attempt: string;
  public readonly completedTestFiles: Set<string> = new Set();
  private readonly _configs: Map<string, Config.ProjectConfig> = new Map();
  private _finished: boolean = false;

  public constructor(attempt: string) {
    this.attempt = attempt;
  }

  public start(test: Test): void {
    if (getCompletionAttempt(test.context.config) !== this.attempt || this._configs.has(test.path)) {
      throw new Error(`Duplicate or stale Jest suite execution: "${test.path}".`);
    }
    this._configs.set(test.path, test.context.config);
  }

  public async observeAsync(test: Test, result: TestResult): Promise<void> {
    if (
      this._configs.get(test.path) !== test.context.config ||
      result.testFilePath !== test.path ||
      this.completedTestFiles.has(test.path)
    ) {
      throw new Error(`Unexpected Jest suite completion: "${test.path}".`);
    }
    await readJestSuiteCompletionAsync(test.context.config, test.path);
    this.completedTestFiles.add(test.path);
  }

  public finish(): void {
    this._finished = true;
  }

  public validate(results: AggregatedResult): void {
    if (
      !this._finished ||
      results.wasInterrupted ||
      results.runExecError ||
      this._configs.size !== this.completedTestFiles.size ||
      results.numTotalTestSuites !== this.completedTestFiles.size ||
      results.testResults.length !== this.completedTestFiles.size
    ) {
      throw new Error('Jest execution did not provide every scheduled suite completion receipt.');
    }
    const remaining: Set<string> = new Set(this.completedTestFiles);
    for (const result of results.testResults) {
      if (!remaining.delete(result.testFilePath)) {
        throw new Error(`Missing or duplicate Jest completion: "${result.testFilePath}".`);
      }
    }
  }

  public async disposeAsync(): Promise<void> {
    for (const [testPath, config] of this._configs) {
      await removeReceiptsAsync(config, testPath);
      this._configs.delete(testPath);
    }
  }
}

interface ICompletionReporterOptions {
  cacheDirectory: string;
}

export default class JestCompletionReporter implements Reporter {
  private readonly _collector: JestCompletionCollector;

  public constructor(globalConfig: Config.GlobalConfig, options: ICompletionReporterOptions) {
    const collector: JestCompletionCollector | undefined = ACTIVE_ATTEMPTS.get(
      getManagedJestExecutionKey(options.cacheDirectory)
    )?.collector;
    if (!collector) throw new Error('Missing managed Jest completion collector.');
    this._collector = collector;
  }

  public onTestStart(test: Test): void {
    this._collector.start(test);
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  public async onTestResult(test: Test, result: TestResult): Promise<void> {
    await this._collector.observeAsync(test, result);
  }

  public onRunComplete(): void {
    this._collector.finish();
  }
}
