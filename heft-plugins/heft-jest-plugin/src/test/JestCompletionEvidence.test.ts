// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { Config, TestResult } from '@jest/reporters';
import { buildFailureTestResult, createEmptyTestResult } from '@jest/test-result';
import { readConfigs } from 'jest-config';

import {
  completeJestSuiteAsync,
  enterJestSuiteAsync,
  getCompletionReceiptPath,
  readJestSuiteCompletionAsync,
  registerManagedJestAttempt,
  scheduleJestSuiteAsync,
  settleJestSuiteAsync
} from '../JestCompletionEvidence';
import { createFixtureAsync } from './JestShardTestHelpers';

describe('attempt-bound Jest suite completion receipts', () => {
  let folder: string;
  let config: Config.ProjectConfig;
  let result: TestResult;
  let releaseAttempt: () => void;

  beforeEach(async () => {
    folder = await createFixtureAsync();
    ({
      configs: [config]
    } = await readConfigs(
      {
        _: [],
        $0: 'completion-evidence',
        config: JSON.stringify({
          rootDir: folder,
          cacheDirectory: path.join(folder, 'cache'),
          testEnvironment: require.resolve('jest-environment-node'),
          transform: {}
        })
      },
      [folder]
    ));
    releaseAttempt = registerManagedJestAttempt(config.cacheDirectory, randomUUID());
    result = createEmptyTestResult();
    result.testFilePath = path.join(folder, 'suite.test.js');
  });

  afterEach(async () => {
    releaseAttempt();
    await fs.rm(folder, { recursive: true, force: true });
  });

  async function settleAsync(): Promise<void> {
    await scheduleJestSuiteAsync(config, result.testFilePath);
    await enterJestSuiteAsync(config, result.testFilePath);
    await settleJestSuiteAsync(
      config,
      result.testFilePath,
      result.testExecError ? 'threw' : 'returned',
      result.testExecError
    );
  }

  it.each(['returned', 'threw'] as const)('accepts a real %s protocol sequence', async (outcome) => {
    if (outcome === 'threw') {
      result = buildFailureTestResult(result.testFilePath, {
        message: 'child process configuration missing',
        stack: 'SIGTERM/worker.js',
        type: 'Error'
      });
    }
    await settleAsync();
    await completeJestSuiteAsync(config, result);
    expect(await readJestSuiteCompletionAsync(config, result.testFilePath)).toBe(outcome);
  });

  it('rejects a retried entry rather than replacing the abandoned invocation', async () => {
    await scheduleJestSuiteAsync(config, result.testFilePath);
    await enterJestSuiteAsync(config, result.testFilePath);
    await expect(enterJestSuiteAsync(config, result.testFilePath)).rejects.toThrow(/EEXIST/);
    await expect(readJestSuiteCompletionAsync(config, result.testFilePath)).rejects.toThrow(/ENOENT/);
  });

  it('accepts a returned Circus result with its original execution error', async () => {
    result.testExecError = { message: 'afterAll failed', stack: 'original afterAll stack', type: 'Error' };
    await scheduleJestSuiteAsync(config, result.testFilePath);
    await enterJestSuiteAsync(config, result.testFilePath);
    await settleJestSuiteAsync(config, result.testFilePath, 'returned', result.testExecError);
    await expect(completeJestSuiteAsync(config, result)).resolves.toBe('returned');
    expect(await readJestSuiteCompletionAsync(config, result.testFilePath)).toBe('returned');
  });

  it('rejects replacement of a returned Circus execution error during teardown', async () => {
    result.testExecError = { message: 'afterAll failed', stack: 'original afterAll stack', type: 'Error' };
    await scheduleJestSuiteAsync(config, result.testFilePath);
    await enterJestSuiteAsync(config, result.testFilePath);
    await settleJestSuiteAsync(config, result.testFilePath, 'returned', result.testExecError);
    result = {
      ...result,
      testExecError: { ...result.testExecError!, message: 'environment teardown failed' }
    };
    await expect(completeJestSuiteAsync(config, result)).rejects.toThrow(/Inconsistent/);
  });

  it('does not accept Circus settlement as outer runner completion', async () => {
    await settleAsync();
    await expect(readJestSuiteCompletionAsync(config, result.testFilePath)).rejects.toThrow(/ENOENT/);
  });

  it.each(['scheduled', 'entered', 'settled', 'completed'] as const)(
    'rejects missing %s evidence',
    async (stage) => {
      await settleAsync();
      await completeJestSuiteAsync(config, result);
      await fs.unlink(getCompletionReceiptPath(config, result.testFilePath, stage));
      await expect(readJestSuiteCompletionAsync(config, result.testFilePath)).rejects.toThrow(/ENOENT/);
    }
  );

  it.each(['digest', 'attempt', 'testPath', 'stage', 'outcome', 'truncated', 'hardlink'] as const)(
    'rejects %s completion evidence using the real file protocol',
    async (fault) => {
      await settleAsync();
      await completeJestSuiteAsync(config, result);
      const filename: string = getCompletionReceiptPath(config, result.testFilePath, 'completed');
      const contents: string = await fs.readFile(filename, 'utf8');
      if (fault === 'hardlink') {
        await fs.link(filename, path.join(folder, 'receipt-alias'));
      } else if (fault === 'truncated') {
        await fs.writeFile(filename, contents.slice(0, -1));
      } else {
        const envelope = JSON.parse(contents);
        const receipt = JSON.parse(envelope.payload);
        switch (fault) {
          case 'digest':
            envelope.sha256 = '0'.repeat(64);
            break;
          case 'attempt':
            receipt.attempt = randomUUID();
            break;
          case 'testPath':
            receipt.testPath = path.join(folder, 'other.test.js');
            break;
          case 'stage':
            receipt.stage = 'settled';
            break;
          case 'outcome':
            receipt.outcome = 'threw';
            break;
        }
        if (fault !== 'digest') {
          envelope.payload = JSON.stringify(receipt);
          envelope.sha256 = createHash('sha256').update(envelope.payload).digest('hex');
        }
        await fs.writeFile(filename, JSON.stringify(envelope));
      }
      await expect(readJestSuiteCompletionAsync(config, result.testFilePath)).rejects.toThrow();
    }
  );

  it('rejects a completed receipt from an earlier attempt even with a correct checksum', async () => {
    await settleAsync();
    await completeJestSuiteAsync(config, result);
    const old: string = await fs.readFile(
      getCompletionReceiptPath(config, result.testFilePath, 'completed'),
      'utf8'
    );
    releaseAttempt();
    releaseAttempt = registerManagedJestAttempt(config.cacheDirectory, randomUUID());
    await settleAsync();
    await fs.writeFile(getCompletionReceiptPath(config, result.testFilePath, 'completed'), old);
    await expect(readJestSuiteCompletionAsync(config, result.testFilePath)).rejects.toThrow(/Stale/);
  });

  it.each(['outer-error', 'leak'] as const)('rejects %s after Circus returned', async (fault) => {
    await settleAsync();
    if (fault === 'leak') result.leaks = true;
    else result.testExecError = { message: 'application configuration missing', stack: '', type: 'Error' };
    await expect(completeJestSuiteAsync(config, result)).rejects.toThrow(/Inconsistent/);
    await expect(readJestSuiteCompletionAsync(config, result.testFilePath)).rejects.toThrow(/ENOENT/);
  });
});
