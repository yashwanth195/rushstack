// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import fsSync, { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import type {
  CommandLineParameter,
  HeftConfiguration,
  IHeftTaskRunHookOptions,
  IHeftTaskSession,
  IScopedLogger
} from '@rushstack/heft';
import { ConsoleTerminalProvider, Terminal } from '@rushstack/terminal';

import JestPlugin from '../JestPlugin';

/**
 * Exercises the registered task hook with real configuration, Jest, reporters and publication.
 * Runs in a child process because nesting Jest inside the test runner shares its module sandbox.
 */
export async function runJestTaskHookAsync(
  folder: string,
  taskName: string,
  abortMicrotasks: number = 0,
  abortOnFile: string = ''
): Promise<void> {
  const controller: AbortController = new AbortController();
  let runHook!: (options: IHeftTaskRunHookOptions) => Promise<void>;
  const terminal: Terminal = new Terminal(new ConsoleTerminalProvider());
  let hasErrors: boolean = false;
  const logger: IScopedLogger = {
    loggerName: taskName,
    terminal,
    get hasErrors(): boolean {
      return hasErrors;
    },
    emitError: (error: Error) => {
      hasErrors = true;
      terminal.writeErrorLine(error.message);
    },
    emitWarning: (error: Error) => terminal.writeWarningLine(error.message),
    resetErrorsAndWarnings: () => {
      hasErrors = false;
    }
  };
  function getParameter<T extends CommandLineParameter>(): T {
    return { value: undefined, values: [] } as unknown as T;
  }
  const session: IHeftTaskSession = {
    taskName,
    tempFolderPath: path.join(folder, 'temp', 'test', taskName),
    logger,
    parameters: {
      getFlagParameter: getParameter,
      getIntegerParameter: getParameter,
      getStringParameter: getParameter,
      getStringListParameter: getParameter
    },
    hooks: {
      run: {
        tapPromise: (pluginName: string, hook: typeof runHook) => {
          runHook = hook;
        }
      },
      runIncremental: { tapPromise: () => {} }
    }
  } as unknown as IHeftTaskSession;
  new JestPlugin().apply(
    session,
    {
      buildFolderPath: folder,
      tempFolderPath: path.join(folder, 'temp'),
      projectPackageJson: { name: 'task-hook-fixture' }
    } as HeftConfiguration,
    {
      shard: '1/1',
      shardOutputDirectory: 'shards/1',
      maxWorkers: '1',
      disableConfigurationModuleResolution: true
    }
  );
  const originalRename: typeof fsSync.renameSync = fsSync.renameSync;
  const cancellationWatcher: FSWatcher | undefined = abortOnFile
    ? watch(folder, (event, filename) => {
        if (filename === abortOnFile) controller.abort(new Error('Cancelled active managed Jest worker'));
      })
    : undefined;
  if (abortMicrotasks) {
    fsSync.renameSync = (...args) => {
      originalRename(...args);
      if (path.basename(String(args[1])) === 'shard-manifest.json') {
        let remaining: number = abortMicrotasks;
        const cancel: () => void = () => {
          if (--remaining === 0) controller.abort(new Error('Cancelled after manifest rename'));
          else queueMicrotask(cancel);
        };
        queueMicrotask(cancel);
      }
    };
  }
  try {
    await runHook({ abortSignal: controller.signal } as IHeftTaskRunHookOptions);
    if (logger.hasErrors) throw new Error('Task hook reported infrastructure errors.');
  } finally {
    cancellationWatcher?.close();
    if (abortMicrotasks) {
      // eslint-disable-next-line require-atomic-updates -- This subprocess owns the temporary rename override.
      fsSync.renameSync = originalRename;
    }
  }
}

// Use a real entry file: Node fork inherits execArgv, including an -e script that would
// otherwise replace jest-worker's processChild entrypoint and exercise the wrong failure.
if (require.main === module) {
  runJestTaskHookAsync(process.cwd(), process.argv[2], Number(process.argv[3]), process.argv[4]).catch(
    async (error: unknown) => {
      if (process.argv[5] === 'fault') {
        await fs.writeFile('fault-host-survived', String(process.pid));
      }
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
