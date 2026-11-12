// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { EventEmitter } from 'node:events';
import { totalmem } from 'node:os';

import { FifoQueue, type WorkerPoolInterface } from 'jest-worker';

type WorkerHandle = ReturnType<WorkerPoolInterface['getWorkers']>[number];
type QueuedTask = Parameters<FifoQueue['enqueue']>[0];

/**
 * Keep Jest's FIFO/pool implementation, but observe its public task callbacks and worker handles.
 * Jest 30.3 counts an idle-memory restart against maxRetries when the next task is already sent.
 * Drain that restart before dispatching another suite; never retry an in-flight suite.
 * The runner dispatches the first task synchronously after pool construction, before yielding.
 */
export class JestManagedWorkerQueue extends FifoQueue {
  public readonly failure: Promise<never>;
  private readonly _idleMemoryLimit: number | undefined;
  private _rejectFailure!: (error: Error) => void;
  private _error: Error | undefined;
  private _worker: WorkerHandle | undefined;
  private _unsubscribe: (() => void) | undefined;
  private _idle: Promise<void> = Promise.resolve();
  private _resolveReady: (() => void) | undefined;
  private _recycling: boolean = false;
  private _finalTask: boolean = false;
  private _finalTaskCompleted: boolean = false;
  private _classifyingFinalRecycle: boolean = false;
  private _replacedAfterFinalTask: boolean = false;
  private _resolveFinalState: ((state: WorkerHandle['state']) => void) | undefined;
  private _ending: boolean = false;

  public constructor(idleMemoryLimit: number | undefined) {
    super();
    this._idleMemoryLimit =
      idleMemoryLimit === undefined
        ? undefined
        : Math.floor(
            idleMemoryLimit > 0 && idleMemoryLimit <= 1 ? totalmem() * idleMemoryLimit : idleMemoryLimit
          );
    this.failure = new Promise((resolve, reject) => {
      this._rejectFailure = reject;
    });
    // Callers race this promise while working, and also check the retained error before shutdown.
    this.failure.catch((error: Error) => {
      this._error = error;
    });
  }

  public override enqueue(task: QueuedTask, workerId?: number): void {
    const isFinalTask: boolean = this._finalTask;
    super.enqueue(
      {
        ...task,
        onStart: (worker) => {
          if (this._worker !== worker) {
            if (this._worker) {
              this._fail(new Error('Managed Jest worker handle was replaced unexpectedly.'));
            }
            this._unsubscribe?.();
            this._worker = worker;
            // WorkerOptions.on declares "state-change"; the built-in handles inherit Node EventEmitter.
            if (!(worker instanceof EventEmitter)) {
              this._fail(new Error('Jest worker does not expose its lifecycle events.'));
            } else {
              const onStateChange = (state: WorkerHandle['state']): void => {
                // A memory response resolves getMemoryUsage before emitting RESTARTING.
                // The zero-limit process path also restarts before task onEnd. Defer both so
                // final-task state and public memory evidence are installed before classification.
                queueMicrotask(() => this._observeState(state));
              };
              worker.on('state-change', onStateChange);
              this._unsubscribe = () => worker.off('state-change', onStateChange);
              this._observeState(worker.state);
            }
          }
          task.onStart(worker);
        },
        onEnd: (error, result) => {
          if (!error && isFinalTask) {
            // The suite result is complete. Any automatic idle-memory replacement now has no
            // work to perform. Classify it without waiting for the replacement to initialize.
            this._finalTaskCompleted = true;
            const worker: WorkerHandle | undefined = this._worker;
            const limit: number | undefined = this._idleMemoryLimit;
            if (worker && limit !== undefined) {
              this._classifyingFinalRecycle = true;
              const finalState: Promise<WorkerHandle['state']> = new Promise((resolve) => {
                this._resolveFinalState = resolve;
              });
              this._idle = this._classifyFinalRecycleAsync(worker, limit, finalState)
                .catch((idleError: Error) => {
                  this._fail(idleError);
                })
                .finally(() => {
                  this._resolveFinalState = undefined;
                  this._classifyingFinalRecycle = false;
                  this._observeState(worker.state);
                });
              this._idle.catch((idleError: Error) => this._fail(idleError));
            }
          } else if (!error && !this._ending && this._worker) {
            const worker: WorkerHandle = this._worker;
            const limit: number | undefined = this._idleMemoryLimit;
            if (limit !== undefined) {
              this._idle = this._waitForIdleAsync(worker, limit);
              this._idle.catch((idleError: Error) => this._fail(idleError));
            }
          }
          task.onEnd(error, result);
        }
      },
      workerId
    );
  }

  public async waitForIdleAsync(): Promise<void> {
    await Promise.race([this._idle, this.failure]);
    this.throwIfFailed();
  }

  public throwIfFailed(): void {
    if (this._error) throw this._error;
  }

  public beginShutdown(): void {
    this._ending = true;
  }

  public get replacedAfterFinalTask(): boolean {
    return this._replacedAfterFinalTask;
  }

  public markFinalTask(): void {
    if (this._finalTask || this._ending) {
      throw new Error('Managed Jest final worker task was already marked.');
    }
    this._finalTask = true;
  }

  public dispose(): void {
    this._unsubscribe?.();
  }

  private async _waitForIdleAsync(worker: WorkerHandle, limit: number): Promise<void> {
    if (limit === 0) {
      // Processes support unconditional recycling; threads currently treat zero as disabled.
      this._recycling = worker.state === 'restarting';
    } else {
      const memory: number | null = await worker.getMemoryUsage();
      if (memory === null) throw new Error('Jest worker did not report its idle memory usage.');
      this._recycling = limit !== 0 && memory > limit;
    }
    if (this._recycling) {
      await new Promise<void>((resolve) => {
        this._resolveReady = resolve;
        this._observeState(worker.state);
      });
      // "ok" means the replacement was spawned, not that its bootstrap can receive shutdown.
      // A public memory response proves the message loop is ready without scheduling another
      // suite (which would trigger another idle-memory recycle).
      if ((await worker.getMemoryUsage()) === null) {
        throw new Error('Recycled Jest worker did not acknowledge readiness.');
      }
    }
  }

  private async _classifyFinalRecycleAsync(
    worker: WorkerHandle,
    limit: number,
    finalState: Promise<WorkerHandle['state']>
  ): Promise<void> {
    if (limit === 0) {
      this._recycling = worker.state === 'restarting';
    } else {
      const result:
        | { memory: number | null; state?: undefined }
        | { memory?: undefined; state: WorkerHandle['state'] } = await Promise.race([
        worker.getMemoryUsage().then((memory) => ({ memory })),
        finalState.then((state) => ({ state }))
      ]);
      if (result.state !== undefined) {
        throw new Error(`Managed Jest worker stopped before reporting final memory usage (${result.state}).`);
      }
      const memory: number | null = result.memory;
      if (memory === null) throw new Error('Jest worker did not report its idle memory usage.');
      this._recycling = memory > limit;
    }
    if (this._recycling && (worker.state === 'restarting' || worker.state === 'starting')) {
      this._replacedAfterFinalTask = true;
    }
  }

  private _observeState(state: WorkerHandle['state']): void {
    if (
      this._finalTaskCompleted &&
      (state === 'restarting' ||
        state === 'starting' ||
        state === 'oom' ||
        state === 'shutting-down' ||
        state === 'shut-down')
    ) {
      this._resolveFinalState?.(state);
    }
    if (this._finalTaskCompleted && this._recycling && (state === 'restarting' || state === 'starting')) {
      this._replacedAfterFinalTask = true;
    }
    if (this._ending || this._classifyingFinalRecycle) return;
    switch (state) {
      case 'ok':
        if (this._recycling) {
          this._recycling = false;
          this._resolveReady?.();
          this._resolveReady = undefined;
        }
        break;
      case 'restarting':
      case 'starting':
        if (!this._recycling) {
          this._fail(new Error('Managed Jest worker restarted unexpectedly.'));
        }
        break;
      case 'oom':
      case 'shutting-down':
      case 'shut-down':
        this._fail(new Error(`Managed Jest worker stopped unexpectedly (${state}).`));
        break;
    }
  }

  private _fail(error: Error): void {
    if (this._error) return;
    this._error = error;
    this._rejectFailure(this._error);
    // maxRetries=0 rejects a replay but Jest may already have spawned a replacement handle
    // internally. Stop that owned process/thread immediately, not after end()'s grace period.
    // Memory recycling reaches here only if its lifecycle/protocol actually failed.
    if (this._worker && this._worker.state !== 'shut-down' && this._worker.state !== 'shutting-down') {
      this._worker.forceExit();
    }
  }
}
