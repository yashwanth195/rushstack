// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type {
  IShardCollationAdapter,
  IShardCollationContext,
  IShardCollationSession,
  IShardCollationVerdict
} from './IShardCollationAdapter';
import { loadShardResultsAsync, type IShardCollationResult } from './ShardCollation';
import { validateShardPathAsync } from './ShardFileSystem';

/**
 * Raw task context. Missing arguments are rejected only after previous reports are invalidated.
 * @public
 */
export interface IShardCollationRunOptions {
  buildFolderPath: string;
  shardParentFolderPath: string | undefined;
  shardCount: number | undefined;
  expectedGeneration: string | undefined;
  /**
   * Transfer the acquired session to an outer task boundary. The callback must not throw.
   * The caller must release it in finally, after checking cancellation and cleaning any
   * publication invalidated by outer completion failure. Omit for a self-contained run.
   */
  onSessionAcquired?: (session: IShardCollationSession) => void;
}

/**
 * Runs one adapter's report lifecycle using Heft's neutral coherence validation. Only a completed
 * report can return a verdict. A failed workload report is retained; infrastructure or
 * cancellation failures after publication invalidate it again.
 * @public
 */
export async function collateShardsAsync(
  options: IShardCollationRunOptions,
  adapter: IShardCollationAdapter,
  abortSignal: AbortSignal
): Promise<IShardCollationVerdict> {
  const { buildFolderPath, shardParentFolderPath, shardCount, expectedGeneration } = options;
  const context: IShardCollationContext = {
    shardParentFolderPath,
    shardCount,
    expectedGeneration,
    abortSignal
  };
  const session: IShardCollationSession = await adapter.acquireAsync(context);
  let transferred: boolean = false;
  try {
    if (options.onSessionAcquired) {
      options.onSessionAcquired(session);
      transferred = true;
    }
    await session.prepareAsync();
    abortSignal.throwIfAborted();
    if (!shardParentFolderPath || shardCount === undefined) {
      throw new Error('Shard collation requires both "--shard-parent-folder" and "--shard-count".');
    }
    await validateShardPathAsync(buildFolderPath, shardParentFolderPath, abortSignal);
    abortSignal.throwIfAborted();
    const result: IShardCollationResult = await loadShardResultsAsync(
      { shardParentFolderPath, shardCount, expectedGeneration },
      abortSignal
    );
    abortSignal.throwIfAborted();
    let completed: boolean = false;
    try {
      const verdict: IShardCollationVerdict = await session.collateAsync(result);
      abortSignal.throwIfAborted();
      if (
        !Number.isSafeInteger(verdict.diagnosticCount) ||
        verdict.diagnosticCount < result.diagnosticCount
      ) {
        throw new Error(
          'An adapter verdict must have a safe diagnostic count at least as large as the manifest total.'
        );
      }
      completed = true;
      return verdict;
    } finally {
      if (!completed) await session.prepareAsync();
    }
  } finally {
    if (!transferred) session.release();
  }
}
