// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { IShardCollationResult } from './ShardCollation';

/**
 * Context available even before collation arguments and manifests have been validated.
 * @public
 */
export interface IShardCollationContext {
  /** Requested shard root; undefined until the caller supplies the collation arguments. */
  shardParentFolderPath: string | undefined;
  /** Requested shard count, never inferred from the available manifests. */
  shardCount?: number;
  /** Current invocation's generation, never inferred from the available manifests. */
  expectedGeneration?: string;
  /** Cancellation revokes publication without skipping cleanup under the retained output claims. */
  abortSignal: AbortSignal;
}

/**
 * Final diagnostics, including any additional adapter-level checks. May never reduce the
 * validated manifest total. Infrastructure failures must throw instead of returning a verdict.
 * @public
 */
export interface IShardCollationVerdict {
  /** Combined diagnostic count, including workload-level collation checks. */
  diagnosticCount: number;
}

/**
 * One exclusively owned report lifecycle. Bound to the acquisition context and real destinations.
 * Methods must reject use after release. Release is synchronous so no cancellation can intervene
 * between the owner's final check and relinquishing ownership.
 * @public
 */
export interface IShardCollationSession {
  /**
   * Validate destination safety, then invalidate previous reports before any input validation.
   * May also be called after unsuccessful collation, including with an aborted signal, to
   * remove a report published immediately before cancellation. Never remove input artifacts.
   */
  prepareAsync(): Promise<void>;

  /**
   * Validate opaque payloads, merge, publish reports atomically, and render workload diagnostics.
   * Throw on infrastructure errors; recorded diagnostics are not infrastructure errors.
   * The neutral task emits the final failure using the returned diagnostic count.
   */
  collateAsync(result: IShardCollationResult): Promise<IShardCollationVerdict>;

  /** Release ownership only after all publication and cancellation cleanup has settled. */
  release(): void;
}

/**
 * One workload's report lifecycle. Register during apply() using IHeftTaskSession.registerShardCollator().
 * @public
 */
export interface IShardCollationAdapter {
  /**
   * Exclusively claim every report destination before preparation, without invalidating reports.
   * Reject conflicting owners without touching their outputs; release partial claims on failure.
   * Cancellation must not skip acquisition/preparation of a previous report.
   */
  acquireAsync(context: IShardCollationContext): Promise<IShardCollationSession>;
}
