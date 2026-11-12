// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { EventEmitter } from 'node:events';

import type { Config, Test, TestResult } from '@jest/reporters';
import type { TestEvents } from '@jest/test-result';
import DefaultJestRunner, { EmittingTestRunner, type TestRunnerOptions, type TestWatcher } from 'jest-runner';
import { Worker, type PromiseWithCustomMessage } from 'jest-worker';

import {
  completeJestSuiteAsync,
  getCompletionAttempt,
  scheduleJestSuiteAsync,
  type JestCompletionOutcome
} from './JestCompletionEvidence';
import { preserveFailedV8CoverageAsync, removeRuntimeCoverageAsync } from './JestCoverageRunner';
import type { IJestManagedWorkerSetup } from './JestManagedWorker';
import { JestManagedWorkerQueue } from './JestManagedWorkerQueue';

interface IManagedWorker extends Worker {
  runSuite(testPath: string): PromiseWithCustomMessage<TestResult>;
}

const ACTIVE_SIGNALS: Map<string, AbortSignal> = new Map();

export async function withJestManagedExecutionAsync<T>(
  attempt: string,
  signal: AbortSignal,
  action: () => Promise<T>
): Promise<T> {
  if (ACTIVE_SIGNALS.has(attempt)) throw new Error('Duplicate managed Jest execution attempt.');
  ACTIVE_SIGNALS.set(attempt, signal);
  try {
    signal.throwIfAborted();
    return await action();
  } finally {
    ACTIVE_SIGNALS.delete(attempt);
  }
}

/** Preserve the scheduler's serial choice; supervise the public one-worker path otherwise. */
export default class JestManagedRunner extends EmittingTestRunner {
  private readonly _emitter: EventEmitter = new EventEmitter();

  public on<Name extends keyof TestEvents>(
    eventName: Name,
    listener: (event: TestEvents[Name]) => void | Promise<void>
  ): () => void {
    this._emitter.on(eventName, listener);
    return () => this._emitter.off(eventName, listener);
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention -- Jest's public runner method.
  public async runTests(tests: Test[], watcher: TestWatcher, options: TestRunnerOptions): Promise<void> {
    if (!tests.length) return;
    const signal: AbortSignal | undefined = ACTIVE_SIGNALS.get(getCompletionAttempt(tests[0].context.config));
    if (!signal) throw new Error('Missing managed Jest execution lifetime.');
    const interruption: AbortController = new AbortController();
    const unsubscribe: () => void = watcher.on('change', (state) => {
      if (state.interrupted) interruption.abort(new Error('Managed Jest scheduler interrupted execution.'));
    });
    const cancellation: AbortSignal = AbortSignal.any([signal, interruption.signal]);
    const throwIfInterrupted = (): void => {
      cancellation.throwIfAborted();
      if (watcher.isInterrupted()) throw new Error('Managed Jest scheduler interrupted execution.');
    };
    const startAsync = async (test: Test): Promise<void> => {
      throwIfInterrupted();
      await this._emitAsync('test-file-start', [test]);
      await scheduleJestSuiteAsync(test.context.config, test.path);
    };
    const completeAsync = async (test: Test, result: TestResult): Promise<void> => {
      throwIfInterrupted();
      if (result.testFilePath !== test.path) throw new Error('Unexpected managed Jest runner result.');
      if (
        this._globalConfig.collectCoverage &&
        this._globalConfig.coverageProvider === 'v8' &&
        (result.testExecError || result.testResults.length === 0)
      ) {
        await preserveFailedV8CoverageAsync(
          test.context.config,
          getCompletionAttempt(test.context.config),
          result
        );
      }
      const outcome: JestCompletionOutcome = await completeJestSuiteAsync(test.context.config, result);
      if (outcome === 'threw') await this._emitAsync('test-file-failure', [test, result.testExecError!]);
      else await this._emitAsync('test-file-success', [test, result]);
    };
    try {
      throwIfInterrupted();
      if (options.serial) {
        const runner: DefaultJestRunner = new DefaultJestRunner(this._globalConfig, this._context);
        const subscriptions: (() => void)[] = [
          runner.on('test-file-start', ([test]) => startAsync(test)),
          runner.on('test-file-success', ([test, result]) => completeAsync(test, result)),
          runner.on('test-file-failure', ([test, error]) => {
            throw new Error(`Jest infrastructure failure in "${test.path}": ${error.stack || error.message}`);
          }),
          runner.on('test-case-start', (args) => this._emitAsync('test-case-start', args)),
          runner.on('test-case-result', (args) => this._emitAsync('test-case-result', args))
        ];
        try {
          await runner.runTests(tests, watcher, options);
        } finally {
          for (const dispose of subscriptions) dispose();
        }
      } else {
        await this._runWorkerAsync(tests, cancellation, startAsync, completeAsync);
      }
      throwIfInterrupted();
    } finally {
      unsubscribe();
      if (this._globalConfig.collectCoverage) {
        for (const test of tests) {
          await removeRuntimeCoverageAsync(
            test.context.config,
            getCompletionAttempt(test.context.config),
            test.path
          );
        }
      }
    }
  }

  private async _runWorkerAsync(
    tests: Test[],
    signal: AbortSignal,
    startAsync: (test: Test) => Promise<void>,
    completeAsync: (test: Test, result: TestResult) => Promise<void>
  ): Promise<void> {
    const config: Config.ProjectConfig = tests[0].context.config;
    if (tests.some((test) => test.context.config !== config)) {
      throw new Error('Managed Jest execution requires one project configuration.');
    }
    // Reporters (including Heft's callback-bearing logger/collectors) execute only in the parent.
    // Keep every test/transform option and user global intact; do not JSON-round-trip this payload.
    const globalConfig: Config.GlobalConfig = { ...this._globalConfig, reporters: undefined };
    const idleMemoryLimit: number | undefined =
      typeof globalConfig.workerIdleMemoryLimit === 'number' ? globalConfig.workerIdleMemoryLimit : undefined;
    const queue: JestManagedWorkerQueue = new JestManagedWorkerQueue(idleMemoryLimit);
    const setup: IJestManagedWorkerSetup = {
      attempt: getCompletionAttempt(config),
      config: { ...config, reporters: [] },
      globalConfig,
      moduleMap: tests[0].context.moduleMap.toJSON(),
      context: {
        changedFiles: this._context.changedFiles && [...this._context.changedFiles],
        sourcesRelatedToTestsInChangedFiles: this._context.sourcesRelatedToTestsInChangedFiles && [
          ...this._context.sourcesRelatedToTestsInChangedFiles
        ]
      }
    };
    await startAsync(tests[0]);
    signal.throwIfAborted();
    // NodeThreadsWorker posts setupArgs only AFTER creating its thread. Pass a validated clone so
    // non-cloneable options cannot throw out of that constructor and orphan the thread.
    const setupArgs: IJestManagedWorkerSetup[] = globalConfig.workerThreads
      ? structuredClone([setup])
      : [setup];
    // No await between construction and the first runSuite below: its synchronous queue onStart
    // attaches initial-handle supervision before any process/thread exit event can be delivered.
    const worker: IManagedWorker = new Worker(require.resolve('./JestManagedWorker'), {
      numWorkers: 1,
      maxRetries: 0,
      enableWorkerThreads: globalConfig.workerThreads,
      idleMemoryLimit,
      forkOptions: { serialization: 'json', stdio: 'pipe' },
      setupArgs,
      exposedMethods: ['runSuite'],
      taskQueue: queue
    }) as IManagedWorker;
    const stdout: NodeJS.ReadableStream = worker.getStdout();
    const stderr: NodeJS.ReadableStream = worker.getStderr();
    stdout.pipe(process.stdout, { end: false });
    stderr.pipe(process.stderr, { end: false });
    let rejectCancellation!: (error: unknown) => void;
    const cancelled: Promise<never> = new Promise((resolve, reject) => {
      rejectCancellation = reject;
    });
    let interruptionReceived: boolean = false;
    let interruptionReason: unknown;
    let forceExited: boolean = false;
    // Retain cancellation even when it arrives during a reporter await rather than a worker await.
    cancelled.catch((error: unknown) => {
      interruptionReceived = true;
      interruptionReason = error;
    });
    const onAbort = (): void => rejectCancellation(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      for (const [index, test] of tests.entries()) {
        if (index !== 0) await startAsync(test);
        signal.throwIfAborted();
        queue.throwIfFailed();
        if (index === tests.length - 1) queue.markFinalTask();
        const pending: PromiseWithCustomMessage<TestResult> = worker.runSuite(test.path);
        const messages: Promise<void>[] = [];
        const disposeMessage: (() => void) | undefined = pending.UNSTABLE_onCustomMessage?.((message) => {
          const forwarded: Promise<void> = this._forwardWorkerMessageAsync(message);
          messages.push(forwarded);
          // Observe rejection immediately; Promise.all below propagates the original event failure.
          forwarded.catch((error: Error) => rejectCancellation(error));
        });
        let result: TestResult;
        try {
          result = await Promise.race([pending, queue.failure, cancelled]);
          await Promise.all(messages);
          await Promise.race([queue.waitForIdleAsync(), cancelled]);
        } finally {
          disposeMessage?.();
        }
        await completeAsync(test, result);
      }
      queue.throwIfFailed();
      if (interruptionReceived) throw interruptionReason;
    } finally {
      signal.removeEventListener('abort', onAbort);
      queue.beginShutdown();
      try {
        ({ forceExited } = await worker.end());
      } finally {
        queue.dispose();
        stdout.unpipe(process.stdout);
        stderr.unpipe(process.stderr);
      }
    }
    if (forceExited && !queue.replacedAfterFinalTask) {
      throw new Error('Managed Jest worker did not shut down gracefully.');
    }
  }

  private async _forwardWorkerMessageAsync(message: unknown): Promise<void> {
    if (!Array.isArray(message) || !Array.isArray(message[1])) {
      throw new Error('Invalid managed Jest worker event.');
    }
    const [eventName, args] = message;
    if (eventName !== 'test-case-start' && eventName !== 'test-case-result') {
      throw new Error('Unexpected managed Jest worker event.');
    }
    await Promise.all(this._emitter.listeners(eventName).map((listener) => listener(args)));
  }

  private async _emitAsync<Name extends keyof TestEvents>(
    eventName: Name,
    args: TestEvents[Name]
  ): Promise<void> {
    await Promise.all(this._emitter.listeners(eventName).map((listener) => listener(args)));
  }
}
