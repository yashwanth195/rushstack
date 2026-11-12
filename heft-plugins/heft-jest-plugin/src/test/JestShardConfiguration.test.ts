// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';

import type { Config } from '@jest/types';
import { JsonSchema } from '@rushstack/node-core-library';

import { configureJestShard, validateManagedJestConfiguration } from '../JestShardConfiguration';

describe('Jest plugin option schema', () => {
  const schema: JsonSchema = JsonSchema.fromFile(
    path.join(__dirname, '..', 'schemas', 'heft-jest-plugin.schema.json')
  );

  it.each([true, false])('accepts the passWithNoTests=%s policy', (passWithNoTests) => {
    expect(() => schema.validateObject({ passWithNoTests }, 'heft.json')).not.toThrow();
  });

  it('rejects a non-boolean passWithNoTests policy', () => {
    expect(() => schema.validateObject({ passWithNoTests: 'false' }, 'heft.json')).toThrow(/passWithNoTests/);
  });
});

describe('configureJestShard', () => {
  const buildFolderPath: string = path.resolve('project');
  const tempFolderPath: string = path.join(buildFolderPath, 'temp', 'test', 'jest');

  it('isolates siblings and partition-count changes', () => {
    const caches: Set<string> = new Set();
    const coverageFolders: Set<string | undefined> = new Set();
    for (const identity of [
      { shardIndex: 1, shardCount: 2 },
      { shardIndex: 2, shardCount: 2 },
      { shardIndex: 1, shardCount: 3 }
    ]) {
      const argv: Config.Argv = { $0: 'heft', _: [], cacheDirectory: tempFolderPath, maxWorkers: '100%' };
      const config: Config.InitialOptions = { coverageDirectory: 'coverage', collectCoverage: true };
      configureJestShard(argv, config, {
        identity,
        tempFolderPath,
        buildFolderPath,
        outputDirectory: undefined
      });

      caches.add(argv.cacheDirectory!);
      coverageFolders.add(config.coverageDirectory);
      expect(argv.cacheDirectory).toBe(
        path.join(tempFolderPath, `shard-${identity.shardIndex}-of-${identity.shardCount}`)
      );
      expect(config.coverageDirectory).toBe(path.join(argv.cacheDirectory!, 'coverage'));
      expect(argv.maxWorkers).toBe(1);
      expect(argv.ci).toBe(true);
      expect(config.collectCoverage).toBe(true);
    }
    expect(caches.size).toBe(3);
    expect(coverageFolders.size).toBe(3);
  });

  it('places coverage inside the Rush-cached shard output', () => {
    const argv: Config.Argv = { $0: 'heft', _: [] };
    const config: Config.InitialOptions = {};
    configureJestShard(argv, config, {
      identity: { shardIndex: 2, shardCount: 4 },
      tempFolderPath,
      buildFolderPath,
      outputDirectory: path.join('temp', 'shards', '2')
    });
    expect(config.coverageDirectory).toBe(path.join(buildFolderPath, 'temp', 'shards', '2', 'coverage'));
    expect(argv.cacheDirectory).toBe(path.join(tempFolderPath, 'shard-2-of-4'));
  });
});

describe('managed Jest configuration', () => {
  it.each([
    { reporters: ['custom-reporter'] },
    { reporters: [['default', { outputFile: '../shared' }]] },
    { testResultsProcessor: 'processor' },
    { projects: ['another-project'] },
    { preset: 'preset' },
    { runner: 'custom-runner' },
    { testRunner: 'custom-runner' },
    { globalSetup: '<rootDir>/global-setup.js' },
    { globalTeardown: '<rootDir>/global-teardown.js' },
    { bail: 1 },
    { coverageThreshold: { global: { lines: 90 } } },
    { coverageReporters: ['custom'] },
    { collectCoverage: true, coverageProvider: 'babel' },
    { coverageReporters: [['json', { file: '../shared' }]] }
  ])('fails closed rather than suppressing unsupported checks: %j', (config) => {
    expect(() => validateManagedJestConfiguration(config as Config.InitialOptions)).toThrow(/Managed Jest/);
  });

  it('supports deferred coverage while preserving the default Heft reporter', () => {
    expect(() => validateManagedJestConfiguration({})).not.toThrow();
    expect(() =>
      validateManagedJestConfiguration({
        reporters: ['default'],
        collectCoverage: false,
        coverageReporters: ['json']
      })
    ).not.toThrow();
    expect(() =>
      validateManagedJestConfiguration({
        collectCoverage: true,
        collectCoverageFrom: ['src/**/*.ts'],
        coverageThreshold: { global: { lines: 100 } },
        coverageReporters: ['lcov', 'json', 'text', 'clover']
      })
    ).not.toThrow();
  });
});
