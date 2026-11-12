// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { Config, TestResult } from '@jest/reporters';
import { buildFailureTestResult, type SerializableError } from '@jest/test-result';
import { shouldInstrument } from '@jest/transform';

import { FileSystem } from '@rushstack/node-core-library';
import {
  validateShardPathAsync,
  writeShardFileAtomicallyAsync
} from '@rushstack/heft/lib/sharding/ShardFileSystem';

import { readCapturedSourceMapAsync } from './JestCoverageSources';
import { originalCoverageConfig } from './JestCoverageTransformer';
import {
  enterJestSuiteAsync,
  getCompletionAttempt,
  removeEmptyJestEvidenceDirectoryAsync,
  settleJestSuiteAsync,
  type JestCompletionOutcome
} from './JestCompletionEvidence';

interface ICoverageEnvironment {
  getVmContext?(): unknown;
}

interface ICoverageRuntime {
  getAllCoverageInfoCopy(): TestResult['coverage'];
  getAllV8CoverageInfoCopy(): TestResult['v8Coverage'];
  getSourceMaps(): ReadonlyMap<string, string>;
}

// Jest exports this JS entry point without a declaration file. Describe the public runner
// parameters we consume; forward all parameters, including the event channel, without modification.
interface ICircusRunner {
  (
    globalConfig: Config.GlobalConfig,
    projectConfig: Config.ProjectConfig,
    environment: ICoverageEnvironment,
    runtime: ICoverageRuntime,
    testPath: string,
    ...rest: unknown[]
  ): Promise<TestResult>;
}

interface ICircusRunnerModule {
  default: ICircusRunner;
}

export interface IJestRuntimeCoverage {
  version: 2;
  attempt: string;
  testPath: string;
  provider: Config.GlobalConfig['coverageProvider'];
  coverage: TestResult['coverage'];
  v8Coverage: TestResult['v8Coverage'];
  sourceMaps: Record<string, unknown>;
}

interface IRuntimeCoverageEnvelope {
  version: 1;
  payload: string;
  sha256: string;
}

export function getRuntimeCoveragePath(
  projectConfig: Config.ProjectConfig,
  attempt: string,
  testPath: string
): string {
  if (!/^[a-f0-9-]{36}$/.test(attempt)) throw new Error('Invalid managed Jest coverage attempt.');
  return path.join(
    projectConfig.cacheDirectory,
    'runtime-coverage',
    attempt,
    `${createHash('sha256').update(testPath).digest('hex')}.json`
  );
}

/**
 * Wrap only Circus work, not environment setup or teardown. Return Jest's public failure-result
 * shape for a settled rejection so the outer runner can collect V8 coverage normally. The managed
 * runner forwards it to Jest's failure callback only after the outer runner successfully returns.
 */
export default async function managedCoverageRunner(
  ...args: Parameters<ICircusRunner>
): ReturnType<ICircusRunner> {
  const [globalConfig, projectConfig, environment, runtime, testPath] = args;
  const attempt: string = getCompletionAttempt(projectConfig);
  if (
    globalConfig.collectCoverage &&
    globalConfig.coverageProvider === 'v8' &&
    !environment.getVmContext?.()
  ) {
    throw new Error('Managed V8 coverage requires an environment with a VM context.');
  }
  const { default: runCircus }: ICircusRunnerModule = require('jest-circus/runner');
  const preserveAsync = async (): Promise<void> => {
    const sourceMaps: Record<string, unknown> = Object.create(null);
    const rawCoverage: TestResult['coverage'] = runtime.getAllCoverageInfoCopy() ?? {};
    if (globalConfig.coverageProvider === 'babel') {
      const captured: ReadonlyMap<string, string> = runtime.getSourceMaps();
      for (const source of Object.keys(rawCoverage)) {
        const sourceMapPath: string | undefined = captured.get(source);
        if (!sourceMapPath)
          throw new Error(`Missing captured Babel instrumentation source map: "${source}".`);
      }
      // This registry is not a load census: a transformer can omit both counters and maps.
      // Retain eligible zero-counter maps as provenance; static candidate validation covers
      // missing instrumentation separately without inventing canonical coverage entries.
      for (const [source, sourceMapPath] of captured) {
        if (
          rawCoverage[source] ||
          shouldInstrument(source, globalConfig, originalCoverageConfig(projectConfig))
        ) {
          const map: unknown = await readCapturedSourceMapAsync(sourceMapPath, !rawCoverage[source]);
          if (map !== undefined) sourceMaps[source] = map;
        }
      }
    }
    const record: IJestRuntimeCoverage = {
      version: 2,
      attempt,
      testPath,
      provider: globalConfig.coverageProvider,
      coverage: rawCoverage,
      v8Coverage: globalConfig.coverageProvider === 'v8' ? runtime.getAllV8CoverageInfoCopy() : undefined,
      sourceMaps
    };
    await writeRuntimeCoverageAsync(projectConfig, record);
  };
  await enterJestSuiteAsync(projectConfig, testPath);
  let result: TestResult;
  let outcome: JestCompletionOutcome = 'returned';
  try {
    result = await runCircus(...args);
  } catch (error) {
    outcome = 'threw';
    const message: string =
      error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
    const stack: string =
      error && typeof error === 'object' && 'stack' in error ? String(error.stack) : message;
    const serialized: SerializableError = { message, stack, type: 'Error' };
    result = buildFailureTestResult(testPath, serialized);
  }
  if (globalConfig.collectCoverage && globalConfig.coverageProvider === 'babel') {
    // Coverage capture failures are outside the Circus catch and must never receive a settled receipt.
    await preserveAsync();
  }
  await settleJestSuiteAsync(projectConfig, testPath, outcome, result.testExecError);
  return result;
}

async function writeRuntimeCoverageAsync(
  projectConfig: Config.ProjectConfig,
  record: IJestRuntimeCoverage
): Promise<void> {
  const filename: string = getRuntimeCoveragePath(projectConfig, record.attempt, record.testPath);
  await validateShardPathAsync(projectConfig.rootDir, filename);
  const payload: string = JSON.stringify(record);
  const envelope: IRuntimeCoverageEnvelope = {
    version: 1,
    payload,
    sha256: createHash('sha256').update(payload).digest('hex')
  };
  await writeShardFileAtomicallyAsync(filename, JSON.stringify(envelope));
}

/** Preserve the public outer runner's raw V8 result before Jest's failure callback discards it. */
export async function preserveFailedV8CoverageAsync(
  projectConfig: Config.ProjectConfig,
  attempt: string,
  result: TestResult
): Promise<void> {
  await writeRuntimeCoverageAsync(projectConfig, {
    version: 2,
    attempt,
    testPath: result.testFilePath,
    provider: 'v8',
    coverage: result.coverage ?? {},
    // Jest omits this property for an empty, successfully collected V8 array.
    v8Coverage: result.v8Coverage ?? [],
    sourceMaps: Object.create(null)
  });
}

export async function removeRuntimeCoverageAsync(
  projectConfig: Config.ProjectConfig,
  attempt: string,
  testPath: string
): Promise<void> {
  const filename: string = getRuntimeCoveragePath(projectConfig, attempt, testPath);
  await validateShardPathAsync(projectConfig.rootDir, filename);
  try {
    const stat: Stats = await fs.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid runtime coverage recovery file.');
    await fs.unlink(filename);
  } catch (error) {
    // Successful reporting consumes the file; startup/capture failures may never create it.
    if (!FileSystem.isNotExistError(error as Error)) throw error;
  }
  await removeEmptyJestEvidenceDirectoryAsync(projectConfig, path.dirname(filename));
}

export async function recoverRuntimeCoverageAsync(
  projectConfig: Config.ProjectConfig,
  attempt: string,
  result: TestResult,
  provider: Config.GlobalConfig['coverageProvider']
): Promise<Record<string, unknown>> {
  const filename: string = getRuntimeCoveragePath(projectConfig, attempt, result.testFilePath);
  await validateShardPathAsync(projectConfig.rootDir, filename);
  const stat: Stats = await fs.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid runtime coverage recovery file.');
  const envelope: IRuntimeCoverageEnvelope = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (
    envelope.version !== 1 ||
    typeof envelope.payload !== 'string' ||
    envelope.sha256 !== createHash('sha256').update(envelope.payload).digest('hex')
  ) {
    throw new Error('Corrupt runtime coverage recovery file.');
  }
  const record: IJestRuntimeCoverage = JSON.parse(envelope.payload);
  if (
    record.version !== 2 ||
    record.attempt !== attempt ||
    record.testPath !== result.testFilePath ||
    record.provider !== provider ||
    !record.sourceMaps ||
    typeof record.sourceMaps !== 'object' ||
    Array.isArray(record.sourceMaps) ||
    (provider === 'v8'
      ? !Array.isArray(record.v8Coverage)
      : !record.coverage || typeof record.coverage !== 'object')
  ) {
    throw new Error('Missing or inconsistent coverage for a failed Jest runtime suite.');
  }
  if (result.testExecError) {
    result.coverage = record.coverage;
    result.v8Coverage = record.v8Coverage;
  }
  await fs.unlink(filename);
  return record.sourceMaps;
}
