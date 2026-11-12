// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { Config, TestContext, TestResult } from '@jest/reporters';
import type { SerializableModuleMap } from 'jest-haste-map';
import type DefaultJestRunner from 'jest-runner';
import type { TestRunnerContext } from 'jest-runner';

import { registerManagedJestAttempt } from './JestCompletionEvidence';

export interface IJestManagedWorkerSetup {
  attempt: string;
  config: Config.ProjectConfig;
  globalConfig: Config.GlobalConfig;
  moduleMap: SerializableModuleMap;
  context: ISerializedRunnerContext;
}

interface ISerializedRunnerContext {
  changedFiles?: string[];
  sourcesRelatedToTestsInChangedFiles?: string[];
}

let runner: DefaultJestRunner;
let context: TestContext;
let TestWatcher: typeof import('jest-watcher').TestWatcher;
let messageParent: typeof import('jest-worker').messageParent;

/** Public jest-worker setup: once per process/thread, including after memory recycling. */
export async function setup(options: IJestManagedWorkerSetup): Promise<void> {
  // Jest loads this entrypoint even when shutting down an unused recycled worker. Keep dependency
  // initialization out of that path and its short shutdown deadline.
  const [{ default: JestHasteMap }, { default: Runner }, { default: Runtime }, watcher, worker] =
    await Promise.all([
      import('jest-haste-map'),
      import('jest-runner'),
      import('jest-runtime'),
      import('jest-watcher'),
      import('jest-worker')
    ]);
  TestWatcher = watcher.TestWatcher;
  messageParent = worker.messageParent;
  const { config, globalConfig } = options;
  registerManagedJestAttempt(config.cacheDirectory, options.attempt);
  context = await Runtime.createContext(config, {
    maxWorkers: 1,
    watchman: globalConfig.watchman,
    watch: false
  });
  // Resolve against the parent's selected haste snapshot, not a new worker-side selection.
  context.moduleMap = JestHasteMap.getStatic(config).getModuleMapFromJSON(options.moduleMap);
  context.resolver = Runtime.createResolver(config, context.moduleMap);
  const runnerContext: TestRunnerContext = {
    changedFiles: options.context.changedFiles && new Set(options.context.changedFiles),
    sourcesRelatedToTestsInChangedFiles:
      options.context.sourcesRelatedToTestsInChangedFiles &&
      new Set(options.context.sourcesRelatedToTestsInChangedFiles)
  };
  runner = new Runner(globalConfig, runnerContext);
}

/** Only the public default runner's success event can return a completed suite through IPC. */
export async function runSuite(testPath: string): Promise<TestResult> {
  let result: TestResult | undefined;
  const unsubscribe: (() => void)[] = [
    runner.on('test-file-success', ([test, completed]) => {
      if (result || test.path !== testPath || completed.testFilePath !== testPath) {
        throw new Error('Unexpected managed worker suite result.');
      }
      result = completed;
    }),
    runner.on('test-file-failure', ([test, error]) => {
      throw new Error(`Jest infrastructure failure in "${test.path}": ${error.stack || error.message}`);
    }),
    runner.on('test-case-start', (args) => messageParent(['test-case-start', args])),
    runner.on('test-case-result', (args) => messageParent(['test-case-result', args]))
  ];
  try {
    // Serial only INSIDE the supervised worker: no inner pool, retries or nested runCLI lifecycle.
    await runner.runTests([{ path: testPath, context }], new TestWatcher({ isWatchMode: false }), {
      serial: true
    });
    if (!result) throw new Error(`Managed worker did not complete "${testPath}".`);
    return result;
  } finally {
    for (const dispose of unsubscribe) dispose();
  }
}
