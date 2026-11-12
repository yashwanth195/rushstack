// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  IShardCollationAdapter,
  IShardCollationContext,
  IShardCollationSession
} from '../IShardCollationAdapter';
import { collateShardsAsync, type IShardCollationRunOptions } from '../ShardCollationRunner';
import { invalidateShardFileAsync, writeShardFileAtomicallyAsync } from '../ShardFileSystem';
import { getShardManifestPath, writeShardResultManifestAsync } from '../ShardResultManifest';

describe('neutral adapter orchestration', () => {
  let folder: string;
  let filename: string;
  let options: IShardCollationRunOptions;
  let controller: AbortController;
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(__dirname, 'collation-runner-'));
    filename = path.join(folder, 'report.json');
    options = {
      buildFolderPath: folder,
      shardParentFolderPath: path.join(folder, 'shards'),
      shardCount: 1,
      expectedGeneration: 'current'
    };
    controller = new AbortController();
    await writeShardResultManifestAsync(path.join(folder, 'shards', '1'), {
      version: 1,
      shardIndex: 1,
      shardCount: 1,
      generation: 'current',
      producerAttempt: 'attempt-1',
      status: 'completed',
      workload: 'example',
      startedAt: '2026-09-14T00:00:00.000Z',
      durationMs: 1,
      itemCount: 1,
      diagnosticCount: 1
    });
    await fs.writeFile(filename, '{"old":true,"success":true}');
  });
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  function createAdapter(
    diagnosticCount: number = 1,
    cancelAfterPublication: boolean = false
  ): IShardCollationAdapter {
    return {
      acquireAsync: async ({ abortSignal }) => ({
        prepareAsync: async () => {
          await invalidateShardFileAsync(filename);
          abortSignal.throwIfAborted();
        },
        collateAsync: async (result) => {
          await writeShardFileAtomicallyAsync(
            filename,
            JSON.stringify({
              diagnosticCount,
              itemCount: result.itemCount,
              success: diagnosticCount === 0
            }),
            abortSignal
          );
          if (cancelAfterPublication) controller.abort(new Error('cancelled after publication'));
          return { diagnosticCount };
        },
        release: () => {}
      })
    };
  }

  it('returns workload failures only after their report is persisted', async () => {
    await expect(collateShardsAsync(options, createAdapter(), controller.signal)).resolves.toEqual({
      diagnosticCount: 1
    });
    expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual({
      diagnosticCount: 1,
      itemCount: 1,
      success: false
    });
  });

  it('allows additional adapter diagnostics without knowing the workload', async () => {
    await expect(collateShardsAsync(options, createAdapter(2), controller.signal)).resolves.toEqual({
      diagnosticCount: 2
    });
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).diagnosticCount).toBe(2);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'invalidates a report whose adapter returned an unsafe or reduced count (%p)',
    async (count) => {
      await expect(collateShardsAsync(options, createAdapter(count), controller.signal)).rejects.toThrow(
        /adapter verdict/
      );
      await expect(fs.readFile(filename)).rejects.toThrow(/ENOENT/);
    }
  );

  it('invalidates a newly published report when cancellation arrives across an awaited adapter stage', async () => {
    await expect(collateShardsAsync(options, createAdapter(1, true), controller.signal)).rejects.toThrow(
      'cancelled after publication'
    );
    expect(await fs.readdir(folder)).toEqual(['shards']);
  });

  it('passes the requested identity through preparation, collation and cancellation cleanup', async () => {
    const contexts: IShardCollationContext[] = [];
    const adapter: IShardCollationAdapter = createAdapter(1, true);
    await expect(
      collateShardsAsync(
        options,
        {
          acquireAsync: async (context) => {
            const session = await adapter.acquireAsync(context);
            return {
              prepareAsync: async () => {
                contexts.push(context);
                await session.prepareAsync();
              },
              collateAsync: async (result) => {
                contexts.push(context);
                return await session.collateAsync(result);
              },
              release: () => session.release()
            };
          }
        },
        controller.signal
      )
    ).rejects.toThrow('cancelled after publication');
    expect(contexts).toEqual(
      Array(3).fill({
        shardParentFolderPath: options.shardParentFolderPath,
        shardCount: options.shardCount,
        expectedGeneration: options.expectedGeneration,
        abortSignal: controller.signal
      })
    );
    await expect(fs.readFile(filename)).rejects.toThrow(/ENOENT/);
  });

  it('removes previous success even when cancelled before preparation', async () => {
    controller.abort(new Error('cancelled before preparation'));
    await expect(collateShardsAsync(options, createAdapter(), controller.signal)).rejects.toThrow(
      'cancelled before preparation'
    );
    await expect(fs.readFile(filename)).rejects.toThrow(/ENOENT/);
  });

  it.each([
    { shardParentFolderPath: undefined },
    { shardCount: undefined },
    { shardCount: 0 },
    { expectedGeneration: undefined },
    { expectedGeneration: 'stale' }
  ])('invalidates before rejecting raw invocation context %j', async (overrides) => {
    await expect(
      collateShardsAsync({ ...options, ...overrides }, createAdapter(), controller.signal)
    ).rejects.toThrow();
    await expect(fs.readFile(filename)).rejects.toThrow(/ENOENT/);
  });

  it('invalidates before reading a corrupt manifest', async () => {
    await fs.writeFile(getShardManifestPath(path.join(folder, 'shards', '1')), '{invalid');
    await expect(collateShardsAsync(options, createAdapter(), controller.signal)).rejects.toThrow(
      /Error reading/
    );
    await expect(fs.readFile(filename)).rejects.toThrow(/ENOENT/);
  });

  it('does not prepare or release an adapter whose claim failed', async () => {
    const contents = await fs.readFile(filename, 'utf8');
    await expect(
      collateShardsAsync(
        options,
        {
          acquireAsync: async () => {
            throw new Error('owned');
          }
        },
        controller.signal
      )
    ).rejects.toThrow('owned');
    expect(await fs.readFile(filename, 'utf8')).toBe(contents);
  });

  it.each(['success', 'validation', 'publication', 'preparation'])(
    'releases a standalone %s session',
    async (stage) => {
      let owned = false;
      const base = createAdapter();
      const adapter: IShardCollationAdapter = {
        acquireAsync: async (context) => {
          if (owned) throw new Error('owned');
          owned = true;
          const session = await base.acquireAsync(context);
          return {
            prepareAsync: async () => {
              if (stage === 'preparation') throw new Error('preparation');
              await session.prepareAsync();
            },
            collateAsync: async (result) => {
              await session.collateAsync(result);
              if (stage === 'publication') throw new Error('publication');
              return { diagnosticCount: result.diagnosticCount };
            },
            release: () => {
              owned = false;
            }
          };
        }
      };
      const run = collateShardsAsync(
        stage === 'validation' ? { ...options, shardCount: 0 } : options,
        adapter,
        controller.signal
      );
      if (stage === 'success') await run;
      else await expect(run).rejects.toThrow();
      expect(owned).toBe(false);
    }
  );

  it('transfers ownership past the runner return without releasing it', async () => {
    let released = false;
    let transferred!: IShardCollationSession;
    const base = createAdapter();
    await collateShardsAsync(
      {
        ...options,
        onSessionAcquired: (session) => {
          transferred = session;
        }
      },
      {
        acquireAsync: async (context) => ({
          ...(await base.acquireAsync(context)),
          release: () => {
            released = true;
          }
        })
      },
      controller.signal
    );
    expect(released).toBe(false);
    controller.abort(new Error('outer cancellation'));
    await expect(transferred.prepareAsync()).rejects.toThrow('outer cancellation');
    await expect(fs.readFile(filename)).rejects.toThrow(/ENOENT/);
    transferred.release();
    expect(released).toBe(true);
  });
});
