// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * Whether a shard was able to run its workload at all.
 *
 * @remarks
 * This is deliberately separate from whether the workload found problems. A shard that runs
 * every test it was given and observes ten failures is `completed`; a shard whose test runner
 * crashed before it could start is `harness-failure`. The distinction matters because a
 * `harness-failure` shard's `diagnosticCount` and `itemCount` are meaningless, so the collator
 * must reject the run rather than merge them.
 *
 * @public
 */
export type ShardStatus = 'completed' | 'harness-failure';

/**
 * What a single shard reports about the work it performed.
 *
 * @remarks
 * Every shard writes one of these as `shard-manifest.json` in its output directory, and doing
 * so is mandatory on the success path. A shard that exits successfully without leaving a
 * manifest behind is indistinguishable from a shard that never ran at all, so the collator
 * treats that case as a failure.
 *
 * The fields above `payload` are deliberately workload-agnostic: `diagnosticCount` and
 * `itemCount` are generic enough that validation and verdict logic need no knowledge of what
 * the shard was actually doing. Anything workload-specific belongs in `payload`.
 *
 * @public
 */
export interface IShardResultManifest {
  /**
   * The version of this manifest format.
   */
  version: 1;

  /**
   * The 1-based index of the shard that produced this manifest, matching the numbering used by
   * both Rush and Jest.
   */
  shardIndex: number;

  /**
   * The total number of shards the producing shard believed it was part of.
   *
   * @remarks
   * The collator compares this against its own shard count. Without it, changing the shard count
   * and then hitting the build cache for a stale shard would silently produce a partial result.
   */
  shardCount: number;

  /**
   * An opaque token identifying the sharded run that produced this manifest.
   *
   * @remarks
   * The collator requires this to be uniform across every manifest it reads AND equal to
   * the current RUSH_SHARD_GENERATION. A uniformly stale set is not a current result.
   */
  generation: string;

  /**
   * A non-semantic token identifying the live execution attempt that published this manifest.
   *
   * @remarks
   * Unlike {@link IShardResultManifest.generation}, this changes for equivalent retries and does
   * not participate in cache identity. It records which fenced writer performed the final commit.
   */
  producerAttempt: string;

  /**
   * Whether the shard ran its workload to completion.
   */
  status: ShardStatus;

  /**
   * The kind of work this shard performed, for example `jest` or `lint`.
   */
  workload: string;

  /**
   * An ISO 8601 timestamp recording when the shard began its workload.
   */
  startedAt: string;

  /**
   * How long the shard's workload took, in milliseconds.
   */
  durationMs: number;

  /**
   * The number of problems the shard found, for example failing tests or lint errors.
   */
  diagnosticCount: number;

  /**
   * The number of units of work the shard actually processed, for example tests run or files
   * linted.
   *
   * @remarks
   * The adapter applies its empty-workload policy after all sibling manifests are validated.
   */
  itemCount: number;

  /**
   * Adapter-specific data that the neutral core passes through without inspecting.
   *
   * @remarks
   * This is optional, whereas the design specifies it as required. An adapter that produces
   * nothing here should not be forced to invent a value, and the collator never reads it, so
   * requiring it would buy nothing.
   */
  payload?: unknown;
}
