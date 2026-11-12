// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';
import fs from 'node:fs/promises';

import { FileSystem, type FolderItem } from '@rushstack/node-core-library';

import type { IShardResultManifest } from './IShardResultManifest';
import { getShardManifestPath, tryReadShardResultManifestAsync } from './ShardResultManifest';

/**
 * What the collator was told by Rush about the sharded run it is collating.
 *
 * @public
 */
export interface IShardCollationRequest {
  /**
   * The folder that contains one subfolder per shard, as passed by Rush via
   * `--shard-parent-folder`.
   */
  shardParentFolderPath: string;

  /**
   * The number of shards Rush scheduled, as passed by Rush via `--shard-count`.
   */
  shardCount: number;

  /**
   * The CURRENT invocation's RUSH_SHARD_GENERATION, not a token inferred from the inputs.
   * Absence or whitespace is an error, even if every manifest agrees.
   */
  expectedGeneration: string | undefined;
}

/**
 * A set of shard results whose neutral envelope has been proven coherent.
 *
 * @public
 */
export interface IShardCollationResult {
  /**
   * Every shard's manifest, ordered by `shardIndex`.
   */
  manifests: readonly IShardResultManifest[];

  /**
   * The generation token shared by all of the manifests.
   */
  generation: string;

  /**
   * The total number of problems reported across all shards.
   */
  diagnosticCount: number;

  /**
   * The total number of units of work processed across all shards.
   */
  itemCount: number;

  /**
   * Whether the run should be reported as successful.
   *
   * @remarks
   * This is the manifest-level verdict. Adapters may add diagnostics in their final verdict
   * but cannot reduce this count. An individual shard never decides whether the build passed.
   */
  passed: boolean;
}

/**
 * Raised when a set of shard results cannot be proven coherent.
 *
 * @remarks
 * Carries every problem found rather than only the first, because a misconfigured sharded run
 * usually violates several rules at once and fixing them one CI cycle at a time is miserable.
 *
 * @public
 */
export class ShardCoherenceError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(
      `The sharded run did not produce a coherent set of results, so its output cannot be trusted:\n` +
        violations.map((violation: string) => `  - ${violation}`).join('\n')
    );

    this.violations = violations;
  }
}

/**
 * Reads whatever manifests are present under the shard parent folder.
 *
 * @remarks
 * This performs no validation beyond that of an individual manifest; it reports what is on disk
 * so that {@link validateShardResults} can explain what is wrong with it. A subfolder without a
 * manifest is silently skipped here and surfaces later as a missing shard, which is the whole
 * point -- a shard that left nothing behind must never be mistaken for a shard that found
 * nothing to do.
 *
 * @public
 */
export async function readShardResultsAsync(
  shardParentFolderPath: string,
  abortSignal?: AbortSignal
): Promise<IShardResultManifest[]> {
  abortSignal?.throwIfAborted();
  let folderItems: FolderItem[];
  try {
    folderItems = await FileSystem.readFolderItemsAsync(shardParentFolderPath);
    abortSignal?.throwIfAborted();
  } catch (error) {
    if (FileSystem.isNotExistError(error as Error)) {
      abortSignal?.throwIfAborted();
      return [];
    }

    throw error;
  }

  const manifests: IShardResultManifest[] = [];
  for (const folderItem of folderItems) {
    abortSignal?.throwIfAborted();
    if (folderItem.isSymbolicLink()) {
      throw new Error(`Shard inputs must not be symbolic links: "${folderItem.name}".`);
    }
    if (!folderItem.isDirectory()) {
      continue;
    }

    const folderPath: string = path.join(shardParentFolderPath, folderItem.name);
    try {
      if ((await fs.lstat(getShardManifestPath(folderPath))).isSymbolicLink()) {
        throw new Error(`Shard manifests must not be symbolic links: "${folderPath}".`);
      }
    } catch (error) {
      if (!FileSystem.isNotExistError(error as Error)) throw error;
    }
    abortSignal?.throwIfAborted();
    const manifest: IShardResultManifest | undefined = await tryReadShardResultManifestAsync(folderPath);
    abortSignal?.throwIfAborted();

    if (manifest) {
      manifests.push(manifest);
    }
  }

  return manifests;
}

function _formatShards(shardIndexes: readonly number[]): string {
  const sorted: number[] = [...shardIndexes].sort((x: number, y: number) => x - y);
  return `${sorted.length === 1 ? 'shard' : 'shards'} ${sorted.join(', ')}`;
}

/**
 * Proves that a set of shard manifests represents one complete, self-consistent run.
 *
 * @remarks
 * This is the substance of the collator. Merging and reporting are mechanical; deciding whether
 * the results are safe to merge at all is not. Every check here exists because failing it would
 * otherwise produce a green build from an incomplete run.
 *
 * The numeric fields are re-checked here even though the manifest schema already constrains
 * them, because this function is the proof step and is reachable with hand-built manifests. A
 * negative or non-finite count would otherwise flow straight into the verdict.
 *
 * @throws {@link ShardCoherenceError} if the results cannot be trusted.
 *
 * @public
 */
export function validateShardResults(
  manifests: readonly IShardResultManifest[],
  shardCount: number
): IShardCollationResult {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(
      `The shard count must be a positive integer in the safe integer range, but it was ${shardCount}.`
    );
  }

  const violations: string[] = [];

  const malformedCounts: string[] = [];
  const invalidIndexes: number[] = [];
  for (const manifest of manifests) {
    if (!Number.isSafeInteger(manifest.shardIndex) || manifest.shardIndex < 1) {
      invalidIndexes.push(manifest.shardIndex);
      continue;
    }

    if (!Number.isSafeInteger(manifest.diagnosticCount) || manifest.diagnosticCount < 0) {
      malformedCounts.push(
        `shard ${manifest.shardIndex} reported a diagnostic count of ${manifest.diagnosticCount}`
      );
    }

    if (!Number.isSafeInteger(manifest.itemCount) || manifest.itemCount < 0) {
      malformedCounts.push(`shard ${manifest.shardIndex} reported an item count of ${manifest.itemCount}`);
    }
  }

  if (invalidIndexes.length > 0) {
    violations.push(
      `${invalidIndexes.length === 1 ? 'a result reports' : 'results report'} an invalid shard ` +
        `index of ${invalidIndexes.join(', ')}`
    );
  }

  violations.push(...malformedCounts);

  const manifestsByIndex: Map<number, IShardResultManifest[]> = new Map();
  for (const manifest of manifests) {
    let group: IShardResultManifest[] | undefined = manifestsByIndex.get(manifest.shardIndex);
    if (!group) {
      group = [];
      manifestsByIndex.set(manifest.shardIndex, group);
    }

    group.push(manifest);
  }

  const missingIndexes: string[] = [];
  const presentIndexes: number[] = [...manifestsByIndex.keys()]
    .filter((index) => Number.isSafeInteger(index) && index >= 1 && index <= shardCount)
    .sort((a, b) => a - b);
  let nextIndex: number = 1;
  let missingCount: number = 0;
  // Bound work by the number of actual manifests, not an untrusted CLI shard count.
  for (const index of [...presentIndexes, shardCount + 1]) {
    const gap: number = index - nextIndex;
    missingCount += gap;
    if (gap > 10) {
      missingIndexes.push(`${nextIndex}-${index - 1}`);
    } else {
      for (let missing: number = nextIndex; missing < index; missing++) {
        missingIndexes.push(String(missing));
      }
    }
    nextIndex = index + 1;
  }

  if (missingIndexes.length > 0) {
    violations.push(
      `no result was found for ${missingCount === 1 ? 'shard' : 'shards'} ${missingIndexes.join(', ')} of ${shardCount}`
    );
  }

  for (const [shardIndex, group] of Array.from(manifestsByIndex).sort(
    (x: [number, IShardResultManifest[]], y: [number, IShardResultManifest[]]) => x[0] - y[0]
  )) {
    if (group.length > 1) {
      violations.push(`${group.length} results claim to be shard ${shardIndex}`);
    }

    if (shardIndex > shardCount) {
      violations.push(`a result claims to be shard ${shardIndex}, but only ${shardCount} were scheduled`);
    }
  }

  const shardIndexesByReportedCount: Map<number, number[]> = new Map();
  const shardIndexesByGeneration: Map<string, number[]> = new Map();
  const harnessFailureIndexes: number[] = [];
  const workloads: Set<string> = new Set();
  let diagnosticCount: number = 0;
  let itemCount: number = 0;

  for (const manifest of manifests) {
    if (!manifest.generation?.trim()) violations.push(`shard ${manifest.shardIndex} has no generation`);
    workloads.add(manifest.workload);
    if (manifest.shardCount !== shardCount) {
      const group: number[] = shardIndexesByReportedCount.get(manifest.shardCount) ?? [];
      group.push(manifest.shardIndex);
      shardIndexesByReportedCount.set(manifest.shardCount, group);
    }

    const generationGroup: number[] = shardIndexesByGeneration.get(manifest.generation) ?? [];
    generationGroup.push(manifest.shardIndex);
    shardIndexesByGeneration.set(manifest.generation, generationGroup);

    if (manifest.status === 'harness-failure') {
      harnessFailureIndexes.push(manifest.shardIndex);
    }

    diagnosticCount += manifest.diagnosticCount;
    itemCount += manifest.itemCount;
  }

  if (workloads.size > 1) violations.push('the results contain mixed workloads');
  if (
    malformedCounts.length === 0 &&
    (!Number.isSafeInteger(diagnosticCount) || !Number.isSafeInteger(itemCount))
  ) {
    violations.push('the combined shard counters exceed the safe integer range');
  }

  for (const [reportedCount, shardIndexes] of Array.from(shardIndexesByReportedCount).sort(
    (x: [number, number[]], y: [number, number[]]) => x[0] - y[0]
  )) {
    violations.push(
      `${shardCount} shards were scheduled, but ${_formatShards(shardIndexes)} ran as part of a ` +
        `${reportedCount}-shard run`
    );
  }

  if (shardIndexesByGeneration.size > 1) {
    const groups: string[] = Array.from(shardIndexesByGeneration)
      .sort((x: [string, number[]], y: [string, number[]]) => Math.min(...x[1]) - Math.min(...y[1]))
      .map(
        ([generation, shardIndexes]: [string, number[]]) =>
          `${_formatShards(shardIndexes)} reported generation "${generation}"`
      );

    violations.push(
      `the results come from ${shardIndexesByGeneration.size} different runs: ` + groups.join('; ')
    );
  }

  if (harnessFailureIndexes.length > 0) {
    violations.push(`${_formatShards(harnessFailureIndexes)} failed to run at all`);
  }

  // A backstop for the §6.1 cardinality rule. The index checks above should already imply it, so
  // this is expected never to fire; it exists so that a hole in that reasoning surfaces as a loud
  // failure rather than a merged partial result.
  if (violations.length === 0 && manifests.length !== shardCount) {
    violations.push(`${manifests.length} results were found, but ${shardCount} shards were scheduled`);
  }

  if (violations.length > 0) {
    throw new ShardCoherenceError(violations);
  }

  const sortedManifests: IShardResultManifest[] = Array.from(manifests).sort(
    (x: IShardResultManifest, y: IShardResultManifest) => x.shardIndex - y.shardIndex
  );

  return {
    manifests: sortedManifests,
    // Safe: a single uniform generation is guaranteed, because zero manifests would already have
    // been reported as missing shards above.
    generation: sortedManifests[0].generation,
    diagnosticCount,
    itemCount,
    passed: diagnosticCount === 0
  };
}

/**
 * Reads every shard result under the parent folder and proves the set is coherent.
 *
 * @throws {@link ShardCoherenceError} if the results cannot be trusted.
 *
 * @public
 */
export async function loadShardResultsAsync(
  request: IShardCollationRequest,
  abortSignal?: AbortSignal
): Promise<IShardCollationResult> {
  abortSignal?.throwIfAborted();
  if (!request.expectedGeneration?.trim()) {
    throw new Error(
      'Shard collation requires the current nonempty RUSH_SHARD_GENERATION environment variable.'
    );
  }
  const manifests: IShardResultManifest[] = await readShardResultsAsync(
    request.shardParentFolderPath,
    abortSignal
  );
  abortSignal?.throwIfAborted();
  const result: IShardCollationResult = validateShardResults(manifests, request.shardCount);
  // Uniformity alone admits an entirely stale cache restore. Count and current generation
  // are independent checks: a shard-count change need not change the generation token.
  if (result.generation !== request.expectedGeneration) {
    throw new ShardCoherenceError(['the results do not match the current RUSH_SHARD_GENERATION']);
  }
  return result;
}
