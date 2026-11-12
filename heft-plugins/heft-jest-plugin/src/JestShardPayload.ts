// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';

import type { AggregatedResult } from '@jest/reporters';

import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';
import { JsonSchema } from '@rushstack/node-core-library';

import schema from './schemas/jest-shard-payload.schema.json';
import { disabledJestCoverage, validateJestCoverage, type IJestCoverage } from './JestCoverage';

export interface IJestShardFailure {
  testName: string;
  messages: string[];
}

export interface IJestShardAssertion {
  title: string;
  fullName: string;
  ancestorTitles: string[];
  status: 'passed' | 'failed' | 'pending' | 'skipped' | 'disabled' | 'todo';
  // eslint-disable-next-line @rushstack/no-new-null -- Jest does not time every skipped assertion.
  durationMs: number | null;
  failureMessages: string[];
}

export interface IJestShardTestFile {
  path: string;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  // eslint-disable-next-line @rushstack/no-new-null -- Explicit JSON null keeps the wire format stable.
  failureMessage: string | null;
  // eslint-disable-next-line @rushstack/no-new-null -- Explicit JSON null keeps the wire format stable.
  executionError: string | null;
  snapshotFailure: boolean;
  failures: IJestShardFailure[];
  /** Required in version 3 payloads; absent from legacy version 2 cache entries. */
  assertions?: IJestShardAssertion[];
}

export type JestShardFailureReason =
  | 'failed-tests'
  | 'failed-suites'
  | 'suite-execution-errors'
  | 'snapshot-failure'
  | 'jest-unsuccessful';

/**
 * Versioned, JSON-only collation input. Never serialize Jest results directly: they can contain
 * Error instances, coverage classes, and machine-specific absolute test paths.
 */
export interface IJestShardPayload {
  version: 2 | 3;
  producerId?: string;
  passWithNoTests: boolean;
  coverage: IJestCoverage;
  testFiles: IJestShardTestFile[];
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  failedSuites: number;
  runtimeErrorSuites: number;
  snapshotFailure: boolean;
  success: boolean;
  failureReasons: JestShardFailureReason[];
}

export interface IJestShardCounts {
  itemCount: number;
  diagnosticCount: number;
}

const PAYLOAD_SCHEMA: JsonSchema = JsonSchema.fromLoadedObject(schema);

export function validateJestShardProducerId(producerId: string): void {
  if (
    !producerId.trim() ||
    path.posix.isAbsolute(producerId) ||
    path.win32.isAbsolute(producerId) ||
    producerId.includes('\\') ||
    producerId.includes(':') ||
    producerId.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid portable task-relative Jest producer identity: "${producerId}".`);
  }
}

function getFailureReasons(payload: IJestShardPayload): JestShardFailureReason[] {
  const reasons: JestShardFailureReason[] = [];
  if (payload.failed > 0) reasons.push('failed-tests');
  if (payload.failedSuites > 0) reasons.push('failed-suites');
  if (payload.runtimeErrorSuites > 0) reasons.push('suite-execution-errors');
  if (payload.snapshotFailure) reasons.push('snapshot-failure');
  if (!payload.success) reasons.push('jest-unsuccessful');
  return reasons;
}

export function getJestShardCounts(payload: IJestShardPayload): IJestShardCounts {
  let diagnosticCount: number = payload.failed;
  for (const file of payload.testFiles) {
    if (file.executionError || (file.failed === 0 && file.failureMessage)) {
      diagnosticCount++;
    }
  }
  if (payload.snapshotFailure) diagnosticCount++;
  if (!payload.success && diagnosticCount === 0) diagnosticCount++;
  const itemCount: number = payload.passed + payload.failed;
  if (!Number.isSafeInteger(itemCount) || !Number.isSafeInteger(diagnosticCount)) {
    throw new Error('Jest shard counters exceed the safe integer range.');
  }
  return { itemCount, diagnosticCount };
}

/**
 * Validates unknown adapter input before collation. Counters, file identities, and failure
 * details must agree; malformed/missing reports are infrastructure errors, not empty results.
 */
export function validateJestShardPayload(value: unknown): IJestShardPayload {
  PAYLOAD_SCHEMA.validateObject(value, 'Jest shard payload');
  const payload: IJestShardPayload = value as IJestShardPayload;
  if (payload.producerId !== undefined) validateJestShardProducerId(payload.producerId);
  validateJestCoverage(payload.coverage);
  const identities: Set<string> = new Set();
  let passed: number = 0;
  let failed: number = 0;
  let skipped: number = 0;
  let todo: number = 0;
  let failedSuites: number = 0;
  let runtimeErrorSuites: number = 0;
  let snapshotFailure: boolean = false;
  for (const file of payload.testFiles) {
    if (
      path.posix.isAbsolute(file.path) ||
      path.win32.isAbsolute(file.path) ||
      file.path.includes('\\') ||
      file.path.includes(':') ||
      file.path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
      identities.has(file.path)
    ) {
      throw new Error(`Invalid or duplicate build-root-relative Jest test file identity: "${file.path}".`);
    }
    identities.add(file.path);
    passed += file.passed;
    failed += file.failed;
    skipped += file.skipped;
    todo += file.todo;
    if (file.executionError) runtimeErrorSuites++;
    if (file.failed > 0 || file.executionError || file.failureMessage) failedSuites++;
    snapshotFailure ||= file.snapshotFailure;
    if (file.failures.length !== file.failed) {
      throw new Error(`Missing Jest assertion failure details for "${file.path}".`);
    }
    if (payload.version === 3 && !file.assertions) {
      throw new Error(`Missing version 3 Jest assertion details for "${file.path}".`);
    }
    if (payload.version === 2 && file.assertions !== undefined) {
      throw new Error('Assertion details require Jest shard payload version 3.');
    }
    if (file.assertions) {
      const counts: Pick<IJestShardTestFile, 'passed' | 'failed' | 'skipped' | 'todo'> = {
        passed: 0,
        failed: 0,
        skipped: 0,
        todo: 0
      };
      const failures: IJestShardFailure[] = [];
      for (const assertion of file.assertions) {
        if (
          assertion.durationMs !== null &&
          (!Number.isFinite(assertion.durationMs) || assertion.durationMs < 0)
        ) {
          throw new Error(`Invalid Jest assertion duration in "${file.path}".`);
        }
        switch (assertion.status) {
          case 'passed':
          case 'todo':
            counts[assertion.status]++;
            break;
          case 'failed':
            counts.failed++;
            failures.push({ testName: assertion.fullName, messages: assertion.failureMessages });
            break;
          default:
            counts.skipped++;
        }
      }
      if (
        Object.entries(counts).some(([key, count]) => count !== file[key as keyof typeof counts]) ||
        JSON.stringify(failures) !== JSON.stringify(file.failures)
      ) {
        throw new Error(`Inconsistent Jest assertion details for "${file.path}".`);
      }
    }
  }
  if (
    passed !== payload.passed ||
    failed !== payload.failed ||
    skipped !== payload.skipped ||
    todo !== payload.todo ||
    failedSuites !== payload.failedSuites ||
    runtimeErrorSuites !== payload.runtimeErrorSuites ||
    (snapshotFailure && !payload.snapshotFailure) ||
    (payload.success && (failedSuites > 0 || payload.snapshotFailure)) ||
    JSON.stringify(payload.failureReasons) !== JSON.stringify(getFailureReasons(payload))
  ) {
    throw new Error('Inconsistent Jest shard counters or success/failure reasons.');
  }
  return payload;
}

/**
 * Also checks the neutral envelope and (when supplied by I7) cross-shard file uniqueness.
 * The caller must perform neutral coherence validation before collating the returned payloads.
 */
export function validateJestShardManifest(
  manifest: IShardResultManifest,
  testFileIdentities?: Set<string>
): IJestShardPayload {
  if (manifest.workload !== 'jest' || manifest.status !== 'completed') {
    throw new Error('Expected a completed Jest shard manifest.');
  }
  const payload: IJestShardPayload = validateJestShardPayload(manifest.payload);
  const { itemCount, diagnosticCount } = getJestShardCounts(payload);
  if (itemCount !== manifest.itemCount || diagnosticCount !== manifest.diagnosticCount) {
    throw new Error('Jest payload counters do not match its shard manifest.');
  }
  if (testFileIdentities) {
    for (const file of payload.testFiles) {
      if (testFileIdentities.has(file.path)) {
        throw new Error(`Duplicate Jest test file across shards: "${file.path}".`);
      }
    }
    for (const file of payload.testFiles) testFileIdentities.add(file.path);
  }
  return payload;
}

export function createJestShardPayload(
  results: AggregatedResult,
  buildFolderPath: string,
  coverage: IJestCoverage = disabledJestCoverage(),
  producerId: string = 'standalone',
  completedTestFiles?: ReadonlySet<string>,
  passWithNoTests: boolean = true
): IJestShardPayload {
  if (coverage.configuration.enabled !== !!results.coverageMap) {
    throw new Error('Jest results and the managed coverage contract disagree about coverage collection.');
  }
  if (results.wasInterrupted || results.runExecError) {
    throw new Error(
      'Jest execution was interrupted or failed in the harness; no completed shard result exists.'
    );
  }
  if (results.snapshot.added || results.snapshot.updated || results.snapshot.didUpdate) {
    throw new Error('Managed Jest execution must not update snapshots. Run snapshot updates unsharded.');
  }
  const testFiles: IJestShardTestFile[] = [];
  for (const suite of results.testResults) {
    const error: typeof suite.testExecError = suite.testExecError;
    const executionError: string | null = error ? error.stack || error.message || String(error.type) : null;
    if (suite.leaks || (error && !completedTestFiles?.has(suite.testFilePath))) {
      throw new Error(
        `Jest infrastructure failure without completion proof in "${suite.testFilePath}": ` +
          `${executionError || 'memory leak'}`
      );
    }
    const failures: IJestShardFailure[] = [];
    const assertions: IJestShardAssertion[] = [];
    let passed: number = 0;
    let failed: number = 0;
    let skipped: number = 0;
    let todo: number = 0;
    for (const assertion of suite.testResults) {
      switch (assertion.status) {
        case 'passed':
          passed++;
          break;
        case 'failed':
          failed++;
          failures.push({ testName: assertion.fullName, messages: [...assertion.failureMessages] });
          break;
        case 'pending':
        case 'skipped':
        case 'disabled':
          skipped++;
          break;
        case 'todo':
          todo++;
          break;
        default:
          throw new Error(`Incomplete Jest assertion result in "${suite.testFilePath}".`);
      }
      assertions.push({
        title: assertion.title,
        fullName: assertion.fullName,
        ancestorTitles: [...assertion.ancestorTitles],
        status: assertion.status,
        durationMs: assertion.duration ?? null,
        failureMessages: [...assertion.failureMessages]
      });
    }
    if (
      passed !== suite.numPassingTests ||
      failed !== suite.numFailingTests ||
      skipped !== suite.numPendingTests ||
      todo !== suite.numTodoTests
    ) {
      throw new Error(`Missing Jest assertion results in "${suite.testFilePath}".`);
    }
    testFiles.push({
      path: path.relative(buildFolderPath, suite.testFilePath).split(path.sep).join('/'),
      passed,
      failed,
      skipped,
      todo,
      failureMessage: suite.failureMessage || null,
      executionError,
      snapshotFailure: suite.snapshot.unmatched > 0,
      failures,
      assertions
    });
  }
  if (
    testFiles.length !== results.numTotalTestSuites ||
    results.numTotalTests !==
      results.numPassedTests + results.numFailedTests + results.numPendingTests + results.numTodoTests
  ) {
    throw new Error('Jest did not return every scheduled test suite or assertion result.');
  }
  const payload: IJestShardPayload = {
    version: 3,
    producerId,
    passWithNoTests,
    coverage,
    testFiles,
    passed: results.numPassedTests,
    failed: results.numFailedTests,
    skipped: results.numPendingTests,
    todo: results.numTodoTests,
    failedSuites: results.numFailedTestSuites,
    runtimeErrorSuites: results.numRuntimeErrorTestSuites,
    snapshotFailure: results.snapshot.failure || results.snapshot.unmatched > 0,
    success: results.success,
    failureReasons: []
  };
  payload.failureReasons = getFailureReasons(payload);
  return validateJestShardPayload(payload);
}
