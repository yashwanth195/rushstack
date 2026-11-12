// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';

import type { AggregatedResult } from '@jest/reporters';

import { FileSystem } from '@rushstack/node-core-library';
import type { IShardIdentity } from '@rushstack/heft/lib/sharding/ShardIdentity';
import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';
import {
  getShardManifestPath,
  invalidateShardResultManifestAsync,
  validateShardResultManifest,
  writeShardResultManifestAsync
} from '@rushstack/heft/lib/sharding/ShardResultManifest';
import {
  acquireShardOutputLocksAsync,
  resolveShardOutputPathAsync,
  type IShardOutputLock,
  type IShardOutputOwner
} from '@rushstack/heft/lib/sharding/ShardOutputOwnership';

import {
  createJestShardPayload,
  getJestShardCounts,
  validateJestShardManifest,
  validateJestShardProducerId,
  type IJestShardPayload
} from './JestShardPayload';
import { disabledJestCoverage, type IJestCoverage } from './JestCoverage';

export { SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME } from '@rushstack/heft/lib/sharding/ShardOutputOwnership';

export interface IJestShardOutputLock extends IShardOutputLock {}

export interface IJestShardExecution {
  identity: IShardIdentity;
  buildFolderPath: string;
  outputFolderPath: string;
  generation: string;
  producerAttempt: string;
  producerId: string;
  passWithNoTests: boolean;
  startedAt: number;
  lock: IJestShardOutputLock;
}

/**
 * Claims one managed shard output folder, validates its producer binding, and removes its previous commit marker.
 * Runs before importing Jest or resolving any user configuration.
 * The caller must release the lock in a finally block after its last publication await.
 * producerId identifies the logical producer (phase/task), not a generation or execution attempt.
 */
export async function prepareJestShardExecutionAsync(
  buildFolderPath: string,
  outputDirectory: string,
  identity: IShardIdentity,
  generation: string | undefined,
  producerId: string = 'standalone',
  passWithNoTests: boolean = true,
  abortSignal?: AbortSignal,
  owner: IShardOutputOwner = {}
): Promise<IJestShardExecution> {
  validateJestShardProducerId(producerId);
  let outputFolderPath: string = path.resolve(buildFolderPath, outputDirectory);
  const relative: string = path.relative(buildFolderPath, outputFolderPath);
  if (
    !outputDirectory.trim() ||
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    path.basename(outputFolderPath) !== String(identity.shardIndex)
  ) {
    throw new Error(
      '"--shard-output-directory" must be below the build folder and its basename must equal the ' +
        `1-based shard index (${identity.shardIndex}). Use a template such as "temp/shards/{shardIndex}".`
    );
  }

  outputFolderPath = await resolveShardOutputPathAsync(buildFolderPath, outputFolderPath, true);
  const realBuildFolderPath: string = await fs.realpath(buildFolderPath);
  const [lock]: IJestShardOutputLock[] = await acquireShardOutputLocksAsync(
    realBuildFolderPath,
    [outputFolderPath],
    {
      project: path.basename(realBuildFolderPath),
      phase: producerId.split('/')[0],
      task: producerId,
      ...owner,
      ...identity,
      generation
    },
    abortSignal
  );
  try {
    const manifestPath: string = getShardManifestPath(outputFolderPath);
    const previousContents: string | undefined = generation?.trim()
      ? await readManagedShardFileAsync(manifestPath)
      : undefined;
    const previousManifest: IShardResultManifest | undefined =
      previousContents === undefined ? undefined : tryParsePreviousManifest(previousContents, manifestPath);
    if (previousManifest && previousManifest.generation === generation) {
      const previousProducerId: string | undefined = (previousManifest.payload as IJestShardPayload)
        .producerId;
      if (!previousProducerId) {
        throw new Error(
          `Missing producer identity in the existing managed Jest manifest in "${outputFolderPath}". ` +
            'Use a new generation or restore a complete result produced by this version of the plugin.'
        );
      }
      if (previousProducerId !== producerId) {
        throw new Error(
          `Managed Jest shard output "${outputFolderPath}" is already bound to producer ` +
            `"${previousProducerId}" for generation "${generation}", not "${producerId}". ` +
            'Distinct Heft tasks must use distinct shard output directories, even when they run sequentially.'
        );
      }
    }
    await invalidateShardResultManifestAsync(outputFolderPath);
    if (!generation?.trim()) {
      throw new Error(
        'Managed Jest sharding requires a nonempty RUSH_SHARD_GENERATION environment variable.'
      );
    }
    return {
      identity,
      buildFolderPath,
      outputFolderPath,
      generation,
      producerAttempt: lock.attemptId,
      producerId,
      passWithNoTests,
      startedAt: Date.now(),
      lock
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * Converts and validates the complete result before atomically committing it.
 * Rejection (including cancellation or malformed results) is an infrastructure failure, never exit 0.
 */
export async function completeJestShardExecutionAsync(
  execution: IJestShardExecution,
  results: AggregatedResult,
  abortSignal: AbortSignal,
  coverage: IJestCoverage = disabledJestCoverage(),
  completedTestFiles?: ReadonlySet<string>
): Promise<IShardResultManifest> {
  if (execution.lock.isReleased) {
    throw new Error(
      `Managed Jest shard output ownership has been released: "${execution.outputFolderPath}".`
    );
  }
  abortSignal.throwIfAborted();
  const payload: IJestShardPayload = createJestShardPayload(
    results,
    execution.buildFolderPath,
    coverage,
    execution.producerId,
    completedTestFiles,
    execution.passWithNoTests
  );
  const { itemCount, diagnosticCount } = getJestShardCounts(payload);
  const manifest: IShardResultManifest = {
    version: 1,
    ...execution.identity,
    generation: execution.generation,
    producerAttempt: execution.producerAttempt,
    workload: 'jest',
    status: 'completed',
    startedAt: new Date(execution.startedAt).toISOString(),
    durationMs: Date.now() - execution.startedAt,
    itemCount,
    diagnosticCount,
    payload
  };
  validateJestShardManifest(manifest);
  await writeShardResultManifestAsync(execution.outputFolderPath, manifest, abortSignal, execution.lock);
  if (abortSignal.aborted) {
    await invalidateShardResultManifestAsync(execution.outputFolderPath);
    abortSignal.throwIfAborted();
  }
  return manifest;
}

function tryParsePreviousManifest(contents: string, filename: string): IShardResultManifest | undefined {
  // Only parse/schema validation is recoverable here. Filesystem failures occur outside this
  // block and propagate. A corrupt or partially written marker is never proof of producer ownership.
  try {
    const manifest: IShardResultManifest = validateShardResultManifest(JSON.parse(contents), filename);
    validateJestShardManifest(manifest);
    return manifest;
  } catch {
    return undefined;
  }
}

async function readManagedShardFileAsync(filename: string): Promise<string | undefined> {
  let stats: BigIntStats;
  try {
    stats = await fs.lstat(filename, { bigint: true });
  } catch (error) {
    if (!FileSystem.isNotExistError(error as Error)) throw error;
    return undefined;
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new Error(`Managed Jest metadata must be a singly linked regular file: "${filename}".`);
  }
  return await fs.readFile(filename, 'utf8');
}
