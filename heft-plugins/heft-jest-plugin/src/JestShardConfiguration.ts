// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';

import type { Config } from '@jest/types';

import { getShardTempFolderPath, type IShardIdentity } from '@rushstack/heft/lib/sharding/ShardIdentity';

import { SUPPORTED_COVERAGE_REPORTERS } from './JestCoverage';

export interface IJestShardConfigurationOptions {
  identity: IShardIdentity;
  tempFolderPath: string;
  buildFolderPath: string;
  outputDirectory: string | undefined;
}

/**
 * Unknown output hooks can both overwrite sibling reports and veto Jest's verdict. Until their
 * semantics are supported, managed execution must reject them rather than silently remove them.
 */
export function validateManagedJestConfiguration(jestConfig: Config.InitialOptions): void {
  const unsupported: string[] = [
    'testResultsProcessor',
    'projects',
    'preset',
    'runner',
    'testRunner',
    'filter',
    'outputFile',
    'json',
    'forceExit',
    'globalSetup',
    'globalTeardown'
  ];
  for (const property of unsupported) {
    if ((jestConfig as Record<string, unknown>)[property] !== undefined) {
      throw new Error(
        `Managed Jest sharding does not support "${property}". Remove it or run without "--shard-output-directory".`
      );
    }
  }
  if (
    jestConfig.reporters !== undefined &&
    (!Array.isArray(jestConfig.reporters) || jestConfig.reporters.some((reporter) => reporter !== 'default'))
  ) {
    throw new Error(
      'Managed Jest sharding supports only the default Heft reporter. Custom reporters may write shared ' +
        'output or report additional failures; use an unsharded run instead.'
    );
  }
  if (jestConfig.bail) {
    throw new Error('Managed Jest sharding does not support "bail": every scheduled test suite must finish.');
  }
  if (jestConfig.coverageThreshold !== undefined && !jestConfig.collectCoverage) {
    throw new Error(
      'Managed Jest coverageThreshold requires collectCoverage. "--disable-code-coverage" cannot bypass required thresholds.'
    );
  }
  if (
    jestConfig.collectCoverage &&
    (jestConfig.coverageProvider ?? 'babel') === 'babel' &&
    !jestConfig.collectCoverageFrom?.length
  ) {
    throw new Error(
      'Managed Jest Babel coverage requires nonempty "collectCoverageFrom" to validate instrumentation completeness.'
    );
  }
  if (
    jestConfig.coverageReporters?.some(
      (reporter) => typeof reporter !== 'string' || !SUPPORTED_COVERAGE_REPORTERS.has(reporter)
    )
  ) {
    throw new Error(
      'Managed Jest sharding supports only builtin coverage reporters without options or output redirects.'
    );
  }
}

/**
 * Overrides shared Jest state only for sharded invocations.
 */
export function configureJestShard(
  jestArgv: Config.Argv,
  jestConfig: Config.InitialOptions,
  options: IJestShardConfigurationOptions
): void {
  const cacheDirectory: string = getShardTempFolderPath(options.tempFolderPath, options.identity);
  jestArgv.cacheDirectory = cacheDirectory;
  jestArgv.maxWorkers = 1;
  // CI mode prevents Jest's implicit creation of new snapshots in the shared source tree.
  jestArgv.ci = true;
  jestConfig.coverageDirectory = options.outputDirectory
    ? path.resolve(options.buildFolderPath, options.outputDirectory, 'coverage')
    : path.join(cacheDirectory, 'coverage');
}
