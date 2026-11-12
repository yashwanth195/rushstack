// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';

import type { CommandLineStringParameter, CommandLineIntegerParameter } from '@rushstack/ts-command-line';

import type { IHeftTaskSession } from '../pluginFramework/HeftTaskSession';
import type {
  IShardCollationAdapter,
  IShardCollationSession,
  IShardCollationVerdict
} from './IShardCollationAdapter';
import { collateShardsAsync } from './ShardCollationRunner';

const HOOK_NAME: 'heft-shard-collation' = 'heft-shard-collation';

/**
 * Installs Heft-owned collation in the registering workload task, without a second plugin or task.
 */
export class ShardCollationTask {
  #registered: boolean = false;

  public register(
    taskSession: Pick<IHeftTaskSession, 'parameters' | 'hooks' | 'logger'>,
    buildFolderPath: string,
    adapter: IShardCollationAdapter
  ): void {
    if (this.#registered) {
      throw new Error('A Heft task requires exactly one collation adapter, not multiple adapters.');
    }
    if (taskSession.parameters.watch || taskSession.parameters.clean) {
      throw new Error(
        'Shard collation does not support watch mode or --clean. Clean in a separate preparation phase.'
      );
    }
    const parentParameter: CommandLineStringParameter =
      taskSession.parameters.getStringParameter('--shard-parent-folder');
    const countParameter: CommandLineIntegerParameter =
      taskSession.parameters.getIntegerParameter('--shard-count');
    this.#registered = true;
    taskSession.hooks.run.tapPromise(HOOK_NAME, async ({ abortSignal }) => {
      const shardParentFolderPath: string | undefined = parentParameter.value?.trim()
        ? path.resolve(buildFolderPath, parentParameter.value)
        : undefined;
      const shardCount: number | undefined = countParameter.value;
      const expectedGeneration: string | undefined = process.env.RUSH_SHARD_GENERATION;
      let session: IShardCollationSession | undefined;
      let runnerCompleted: boolean = false;
      let completed: boolean = false;
      try {
        const verdict: IShardCollationVerdict = await collateShardsAsync(
          {
            buildFolderPath,
            shardParentFolderPath,
            shardCount,
            expectedGeneration,
            onSessionAcquired: (acquired) => {
              session = acquired;
            }
          },
          adapter,
          abortSignal
        );
        runnerCompleted = true;
        abortSignal.throwIfAborted();
        if (verdict.diagnosticCount > 0) {
          taskSession.logger.emitError(
            new Error(`Sharded run failed with ${verdict.diagnosticCount} diagnostics.`)
          );
        }
        abortSignal.throwIfAborted();
        completed = true;
      } finally {
        try {
          // The runner already cleans failures before it returns. Its successful return
          // is still inside this task's ownership and final cancellation boundary.
          if (runnerCompleted && !completed) await session!.prepareAsync();
        } finally {
          session?.release();
        }
      }
    });
  }
}
