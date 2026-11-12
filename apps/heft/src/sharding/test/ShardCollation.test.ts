// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import { FileSystem } from '@rushstack/node-core-library';

import type { IShardResultManifest } from '../IShardResultManifest';
import {
  type IShardCollationResult,
  ShardCoherenceError,
  loadShardResultsAsync,
  readShardResultsAsync,
  validateShardResults
} from '../ShardCollation';
import { writeShardResultManifestAsync } from '../ShardResultManifest';

function createManifest(overrides?: Partial<IShardResultManifest>): IShardResultManifest {
  return {
    version: 1,
    shardIndex: 1,
    shardCount: 4,
    generation: 'gen-1',
    producerAttempt: 'attempt-1',
    status: 'completed',
    workload: 'jest',
    startedAt: '2026-09-14T00:00:00.000Z',
    durationMs: 100,
    diagnosticCount: 0,
    itemCount: 5,
    ...overrides
  };
}

function createManifests(
  shardCount: number,
  overridesByIndex?: ReadonlyMap<number, Partial<IShardResultManifest>>
): IShardResultManifest[] {
  const manifests: IShardResultManifest[] = [];
  for (let shardIndex: number = 1; shardIndex <= shardCount; shardIndex++) {
    manifests.push(createManifest({ shardIndex, shardCount, ...overridesByIndex?.get(shardIndex) }));
  }

  return manifests;
}

function expectViolations(manifests: readonly IShardResultManifest[], shardCount: number): string[] {
  try {
    validateShardResults(manifests, shardCount);
  } catch (error) {
    if (error instanceof ShardCoherenceError) {
      return [...error.violations];
    }

    throw error;
  }

  throw new Error('Expected validateShardResults to reject these results, but it accepted them.');
}

describe('validateShardResults', () => {
  it('accepts a complete, self-consistent set of results', () => {
    const result: IShardCollationResult = validateShardResults(createManifests(4), 4);

    expect(result.manifests).toHaveLength(4);
    expect(result.generation).toEqual('gen-1');
    expect(result.itemCount).toEqual(20);
    expect(result.diagnosticCount).toEqual(0);
    expect(result.passed).toBe(true);
  });

  it('orders the manifests by shard index regardless of discovery order', () => {
    const manifests: IShardResultManifest[] = createManifests(4).reverse();

    expect(
      validateShardResults(manifests, 4).manifests.map((m: IShardResultManifest) => m.shardIndex)
    ).toEqual([1, 2, 3, 4]);
  });

  it('fails the run when any shard reported a problem', () => {
    const result: IShardCollationResult = validateShardResults(
      createManifests(4, new Map([[3, { diagnosticCount: 2 }]])),
      4
    );

    expect(result.diagnosticCount).toEqual(2);
    expect(result.passed).toBe(false);
  });

  it('rejects a missing shard rather than treating it as an empty result', () => {
    const manifests: IShardResultManifest[] = createManifests(4).filter(
      (m: IShardResultManifest) => m.shardIndex !== 4
    );

    expect(expectViolations(manifests, 4)).toEqual(['no result was found for shard 4 of 4']);
  });

  it('names every missing shard', () => {
    const manifests: IShardResultManifest[] = createManifests(4).filter(
      (m: IShardResultManifest) => m.shardIndex === 2
    );

    expect(expectViolations(manifests, 4)).toEqual(['no result was found for shards 1, 3, 4 of 4']);
  });

  it('rejects two results claiming the same shard index', () => {
    const manifests: IShardResultManifest[] = [
      ...createManifests(4),
      createManifest({ shardIndex: 2, shardCount: 4 })
    ];

    expect(expectViolations(manifests, 4)).toEqual(['2 results claim to be shard 2']);
  });

  it('rejects a result from outside the scheduled shard range', () => {
    const manifests: IShardResultManifest[] = [
      ...createManifests(4),
      createManifest({ shardIndex: 5, shardCount: 4 })
    ];

    expect(expectViolations(manifests, 4)).toEqual([
      'a result claims to be shard 5, but only 4 were scheduled'
    ]);
  });

  it('rejects results produced under a different shard count', () => {
    const manifests: IShardResultManifest[] = createManifests(4, new Map([[2, { shardCount: 5 }]]));

    expect(expectViolations(manifests, 4)).toEqual([
      '4 shards were scheduled, but shard 2 ran as part of a 5-shard run'
    ]);
  });

  it('names every shard that ran under a different shard count', () => {
    const manifests: IShardResultManifest[] = createManifests(
      4,
      new Map([
        [2, { shardCount: 5 }],
        [3, { shardCount: 5 }],
        [4, { shardCount: 9 }]
      ])
    );

    expect(expectViolations(manifests, 4)).toEqual([
      '4 shards were scheduled, but shards 2, 3 ran as part of a 5-shard run',
      '4 shards were scheduled, but shard 4 ran as part of a 9-shard run'
    ]);
  });

  it('rejects a result reporting a shard index below one', () => {
    const manifests: IShardResultManifest[] = [
      ...createManifests(4),
      createManifest({ shardIndex: 0, shardCount: 4, itemCount: 100 })
    ];

    expect(expectViolations(manifests, 4)).toEqual(['a result reports an invalid shard index of 0']);
  });

  it.each([
    { description: 'a negative diagnostic count', overrides: { diagnosticCount: -5 } },
    { description: 'a non-integer diagnostic count', overrides: { diagnosticCount: 1.5 } },
    { description: 'a negative item count', overrides: { itemCount: -5 } },
    { description: 'a NaN item count', overrides: { itemCount: Number.NaN } }
  ])('rejects $description rather than folding it into the verdict', ({ overrides }) => {
    const manifests: IShardResultManifest[] = createManifests(4, new Map([[2, overrides]]));

    expect(expectViolations(manifests, 4)).toEqual([
      expect.stringMatching(/^shard 2 reported a[n]? (diagnostic|item) count of /) as unknown as string
    ]);
  });

  it('does not let a negative diagnostic count cancel out a real failure', () => {
    const manifests: IShardResultManifest[] = createManifests(
      4,
      new Map([
        [1, { diagnosticCount: -5 }],
        [2, { diagnosticCount: 5 }]
      ])
    );

    expect(expectViolations(manifests, 4)).toEqual(['shard 1 reported a diagnostic count of -5']);
  });

  it('rejects results that came from more than one run', () => {
    const manifests: IShardResultManifest[] = createManifests(4, new Map([[3, { generation: 'gen-2' }]]));

    expect(expectViolations(manifests, 4)).toEqual([
      'the results come from 2 different runs: shards 1, 2, 4 reported generation "gen-1"; ' +
        'shard 3 reported generation "gen-2"'
    ]);
  });

  it('rejects a shard that could not run its workload at all', () => {
    const manifests: IShardResultManifest[] = createManifests(
      4,
      new Map([[2, { status: 'harness-failure', itemCount: 0 }]])
    );

    expect(expectViolations(manifests, 4)).toEqual(['shard 2 failed to run at all']);
  });

  it('defers a collectively empty workload verdict to the adapter', () => {
    const manifests: IShardResultManifest[] = createManifests(
      4,
      new Map([
        [1, { itemCount: 0 }],
        [2, { itemCount: 0 }],
        [3, { itemCount: 0 }],
        [4, { itemCount: 0 }]
      ])
    );

    expect(validateShardResults(manifests, 4)).toMatchObject({
      itemCount: 0,
      diagnosticCount: 0,
      passed: true
    });
  });

  it('preserves a failed verdict when every shard has diagnostics but no completed items', () => {
    const manifests: IShardResultManifest[] = createManifests(
      2,
      new Map([
        [1, { itemCount: 0, diagnosticCount: 1 }],
        [2, { itemCount: 0, diagnosticCount: 1 }]
      ])
    );

    expect(validateShardResults(manifests, 2)).toMatchObject({
      itemCount: 0,
      diagnosticCount: 2,
      passed: false
    });
  });

  it('allows empty siblings alongside a diagnostic-only failure without making the verdict green', () => {
    const manifests: IShardResultManifest[] = createManifests(
      2,
      new Map([
        [1, { itemCount: 0, diagnosticCount: 1 }],
        [2, { itemCount: 0 }]
      ])
    );

    expect(validateShardResults(manifests, 2)).toMatchObject({
      itemCount: 0,
      diagnosticCount: 1,
      passed: false
    });
  });

  it('accepts a run in which only some shards had nothing to process', () => {
    const manifests: IShardResultManifest[] = createManifests(
      4,
      new Map([
        [1, { itemCount: 0 }],
        [2, { itemCount: 0 }],
        [3, { itemCount: 0 }]
      ])
    );

    expect(validateShardResults(manifests, 4).itemCount).toEqual(5);
  });

  it('reports every violation at once rather than only the first', () => {
    const manifests: IShardResultManifest[] = [
      createManifest({ shardIndex: 1, shardCount: 4 }),
      createManifest({ shardIndex: 2, shardCount: 9, generation: 'gen-2' }),
      createManifest({ shardIndex: 3, shardCount: 4, status: 'harness-failure' })
    ];

    expect(expectViolations(manifests, 4)).toEqual([
      'no result was found for shard 4 of 4',
      '4 shards were scheduled, but shard 2 ran as part of a 9-shard run',
      'the results come from 2 different runs: shards 1, 3 reported generation "gen-1"; ' +
        'shard 2 reported generation "gen-2"',
      'shard 3 failed to run at all'
    ]);
  });

  it('does not blame an empty run when the real problem is that no shard reported', () => {
    expect(expectViolations([], 4)).toEqual(['no result was found for shards 1, 2, 3, 4 of 4']);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a shard count of %p', (shardCount: number) => {
    expect(() => validateShardResults(createManifests(4), shardCount)).toThrow(
      /shard count must be a positive integer/
    );
  });

  it('rejects mixed workloads without interpreting adapter payloads', () => {
    expect(() => validateShardResults(createManifests(2, new Map([[2, { workload: 'lint' }]])), 2)).toThrow(
      /mixed workloads/
    );
  });

  it.each(['itemCount', 'diagnosticCount'] as const)('rejects unsafe individual and summed %s', (field) => {
    expect(() =>
      validateShardResults(createManifests(2, new Map([[1, { [field]: Number.MAX_SAFE_INTEGER + 1 }]])), 2)
    ).toThrow(/count of/);
    expect(() =>
      validateShardResults(
        createManifests(
          2,
          new Map([
            [1, { [field]: Number.MAX_SAFE_INTEGER }],
            [2, { [field]: 1 }]
          ])
        ),
        2
      )
    ).toThrow(/combined shard counters/);
  });

  it('rejects huge counts promptly without enumerating untrusted shard indexes', () => {
    expect(() => validateShardResults([], Number.MAX_SAFE_INTEGER)).toThrow(/no result was found/);
    expect(() => validateShardResults([], Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer range/);
  });
});

describe('readShardResultsAsync', () => {
  let shardParentFolderPath: string;

  beforeEach(async () => {
    shardParentFolderPath = await fs.mkdtemp(path.join(__dirname, 'heft-shard-parent-'));
  });

  afterEach(async () => {
    await FileSystem.deleteFolderAsync(shardParentFolderPath);
  });

  async function writeShardsAsync(manifests: readonly IShardResultManifest[]): Promise<void> {
    for (const manifest of manifests) {
      await writeShardResultManifestAsync(
        path.join(shardParentFolderPath, `${manifest.shardIndex}`),
        manifest
      );
    }
  }

  it('reads every manifest written beneath the parent folder', async () => {
    await writeShardsAsync(createManifests(4));

    const manifests: IShardResultManifest[] = await readShardResultsAsync(shardParentFolderPath);
    expect(manifests.map((m: IShardResultManifest) => m.shardIndex).sort()).toEqual([1, 2, 3, 4]);
  });

  it('reports no results when the parent folder does not exist', async () => {
    await expect(readShardResultsAsync(path.join(shardParentFolderPath, 'never-created'))).resolves.toEqual(
      []
    );
  });

  it('skips a shard folder that contains no manifest', async () => {
    await writeShardsAsync(createManifests(4));
    await FileSystem.deleteFileAsync(path.join(shardParentFolderPath, '4', 'shard-manifest.json'));

    await expect(readShardResultsAsync(shardParentFolderPath)).resolves.toHaveLength(3);
  });

  it('ignores loose files alongside the shard folders', async () => {
    await writeShardsAsync(createManifests(4));
    await FileSystem.writeFileAsync(path.join(shardParentFolderPath, 'notes.txt'), 'hello');

    await expect(readShardResultsAsync(shardParentFolderPath)).resolves.toHaveLength(4);
  });

  it('refuses to skip a shard folder whose manifest is corrupt', async () => {
    await writeShardsAsync(createManifests(4));
    await FileSystem.writeFileAsync(
      path.join(shardParentFolderPath, '2', 'shard-manifest.json'),
      '{ not json'
    );

    await expect(readShardResultsAsync(shardParentFolderPath)).rejects.toThrow(/Error reading/);
  });

  it('reads the shard index from the manifest rather than the folder name', async () => {
    await writeShardResultManifestAsync(
      path.join(shardParentFolderPath, 'not-a-number'),
      createManifest({ shardIndex: 2, shardCount: 4 })
    );

    const manifests: IShardResultManifest[] = await readShardResultsAsync(shardParentFolderPath);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].shardIndex).toEqual(2);
  });
});

describe('loadShardResultsAsync', () => {
  let shardParentFolderPath: string;

  beforeEach(async () => {
    shardParentFolderPath = await fs.mkdtemp(path.join(__dirname, 'heft-shard-parent-'));
  });

  afterEach(async () => {
    await FileSystem.deleteFolderAsync(shardParentFolderPath);
  });

  it('accepts a complete run written to disk', async () => {
    for (const manifest of createManifests(4)) {
      await writeShardResultManifestAsync(
        path.join(shardParentFolderPath, `${manifest.shardIndex}`),
        manifest
      );
    }

    const result: IShardCollationResult = await loadShardResultsAsync({
      shardParentFolderPath,
      shardCount: 4,
      expectedGeneration: 'gen-1'
    });

    expect(result.passed).toBe(true);
    expect(result.itemCount).toEqual(20);
  });

  it('rejects a run whose shard folder was never created', async () => {
    for (const manifest of createManifests(4).slice(0, 3)) {
      await writeShardResultManifestAsync(
        path.join(shardParentFolderPath, `${manifest.shardIndex}`),
        manifest
      );
    }

    await expect(
      loadShardResultsAsync({ shardParentFolderPath, shardCount: 4, expectedGeneration: 'gen-1' })
    ).rejects.toThrow(ShardCoherenceError);
  });

  it('rejects an entirely uniform but stale result set', async () => {
    for (const manifest of createManifests(2)) {
      await writeShardResultManifestAsync(
        path.join(shardParentFolderPath, String(manifest.shardIndex)),
        manifest
      );
    }
    await expect(
      loadShardResultsAsync({
        shardParentFolderPath,
        shardCount: 2,
        expectedGeneration: 'current'
      })
    ).rejects.toThrow(/current RUSH_SHARD_GENERATION/);
  });

  it.each([undefined, '', '  '])('requires current generation context (%j)', async (expectedGeneration) => {
    await expect(
      loadShardResultsAsync({
        shardParentFolderPath,
        shardCount: 2,
        expectedGeneration
      })
    ).rejects.toThrow(/RUSH_SHARD_GENERATION/);
  });

  it('propagates cancellation instead of returning an empty or successful set', async () => {
    const controller: AbortController = new AbortController();
    controller.abort(new Error('cancelled collation'));
    await expect(
      loadShardResultsAsync(
        {
          shardParentFolderPath,
          shardCount: 2,
          expectedGeneration: 'gen-1'
        },
        controller.signal
      )
    ).rejects.toThrow('cancelled collation');
  });
});
