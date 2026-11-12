// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { makeEmptyAggregatedTestResult } from '@jest/test-result';

import { Async, FileSystem } from '@rushstack/node-core-library';
import * as shardManifest from '@rushstack/heft/lib/sharding/ShardResultManifest';
import {
  getShardManifestPath,
  readShardResultManifestAsync,
  tryReadShardResultManifestAsync
} from '@rushstack/heft/lib/sharding/ShardResultManifest';

import {
  completeJestShardExecutionAsync,
  SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME,
  prepareJestShardExecutionAsync,
  type IJestShardExecution
} from '../JestShardExecution';
import type { IJestShardPayload } from '../JestShardPayload';
import {
  acquireShardOutputLocksAsync,
  getShardOutputIdentity,
  releaseShardOutputLocks,
  resolveShardOutputPathAsync
} from '@rushstack/heft/lib/sharding/ShardOutputOwnership';
import {
  createFixtureAsync,
  runHeftAsync,
  runJestTaskHookInChildAsync,
  writeConfigAsync,
  type ICliResult
} from './JestShardTestHelpers';

const compiledFolder: string = path.dirname(__dirname);
const shortCompiledFolderName: string | undefined =
  process.platform === 'win32'
    ? execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:HEFT_SHARD_ALIAS_DIRECTORY).ShortName'
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, HEFT_SHARD_ALIAS_DIRECTORY: compiledFolder }
        }
      ).trim()
    : undefined;
const hasShortPathAlias: boolean =
  !!shortCompiledFolderName &&
  shortCompiledFolderName.toLowerCase() !== path.basename(compiledFolder).toLowerCase();

describe('managed Jest destination ownership', () => {
  let folder: string;
  let outputFolder: string;
  const executions: IJestShardExecution[] = [];

  beforeEach(async () => {
    folder = await createFixtureAsync();
    outputFolder = path.join(folder, 'shards', '1');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const execution of executions) {
      if (!execution.lock.isReleased) execution.lock.release();
    }
    executions.length = 0;
    await fs.rm(folder, { recursive: true, force: true });
  });

  async function prepareAsync(
    buildFolder: string = folder,
    producerId: string = 'standalone'
  ): Promise<IJestShardExecution> {
    const execution: IJestShardExecution = await prepareJestShardExecutionAsync(
      buildFolder,
      'shards/1',
      { shardIndex: 1, shardCount: 1 },
      'generation-1',
      producerId
    );
    executions.push(execution);
    return execution;
  }

  it('publishes the attempt identity from its actual output claim', async () => {
    const execution: IJestShardExecution = await prepareAsync();
    const claim: { attemptId: string; generation: string } = JSON.parse(
      await fs.readFile(execution.lock.filePath, 'utf8')
    );
    expect(execution.producerAttempt).toBe(claim.attemptId);
    expect(claim.generation).toBe(execution.generation);
    const manifest = await completeJestShardExecutionAsync(
      execution,
      makeEmptyAggregatedTestResult(),
      new AbortController().signal
    );
    expect(manifest.producerAttempt).toBe(claim.attemptId);
  });

  it('retains exclusive ownership through publication and permits a subsequent retry', async () => {
    const owner: IJestShardExecution = await prepareAsync();
    const manifest = await completeJestShardExecutionAsync(
      owner,
      makeEmptyAggregatedTestResult(),
      new AbortController().signal
    );
    await expect(prepareAsync()).rejects.toThrow(/already owned/);
    expect(await readShardResultManifestAsync(outputFolder)).toEqual(manifest);
    expect(path.relative(outputFolder, owner.lock.filePath)).toMatch(/^\.\./);
    expect(path.dirname(owner.lock.filePath)).toBe(path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME));
    expect(await fs.readdir(outputFolder, { withFileTypes: true })).toHaveLength(1);
    owner.lock.release();
    await prepareAsync();
    await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    await expect(
      completeJestShardExecutionAsync(owner, makeEmptyAggregatedTestResult(), new AbortController().signal)
    ).rejects.toThrow(/ownership has been released/);
  });

  it('shares ownership through a symlinked workspace root', async () => {
    const alias: string = path.join(folder, 'workspace-alias');
    await fs.symlink(folder, alias, 'junction');
    const owner: IJestShardExecution = await prepareAsync(alias);
    await expect(prepareAsync()).rejects.toThrow(/already owned/);
    owner.lock.release();
    await prepareAsync();
  });

  (process.platform === 'win32' ? it : it.skip)('shares ownership through Windows case aliases', async () => {
    await prepareAsync();
    await expect(
      prepareJestShardExecutionAsync(folder, 'SHARDS/1', { shardIndex: 1, shardCount: 1 }, 'generation-1')
    ).rejects.toThrow(/already owned/);
  });

  it('shares ownership through missing case aliases on case-insensitive filesystems', async () => {
    const probe: string = path.join(folder, 'case-sensitivity-probe');
    await fs.writeFile(probe, '');
    let caseInsensitive: boolean;
    try {
      try {
        await fs.access(path.join(folder, 'CASE-SENSITIVITY-PROBE'));
        caseInsensitive = true;
      } catch (error) {
        if (!FileSystem.isNotExistError(error as Error)) throw error;
        caseInsensitive = false;
      }
    } finally {
      await fs.unlink(probe);
    }
    if (!caseInsensitive) return;
    const locks = await acquireShardOutputLocksAsync(folder, [
      path.join(folder, 'Reports', 'jest-collated.json')
    ]);
    try {
      await expect(
        acquireShardOutputLocksAsync(folder, [path.join(folder, 'reports', 'JEST-COLLATED.json')])
      ).rejects.toThrow(/already owned/);
    } finally {
      releaseShardOutputLocks(locks);
    }
  });

  it('normalizes Unicode composition without approximating filesystem case folding', () => {
    const composed: string = path.join(folder, 'reports', '\u00e9.json');
    const decomposed: string = path.join(folder, 'reports', 'e\u0301.json');
    expect(getShardOutputIdentity(folder, composed)).toBe(getShardOutputIdentity(folder, decomposed));
    expect(getShardOutputIdentity(folder, path.join(folder, 'Reports', '\u00e9.json'))).not.toBe(
      getShardOutputIdentity(folder, composed)
    );
  });

  it('uses filesystem Unicode case equivalence for missing output leaves', async () => {
    const probe: string = path.join(folder, '\u00df-probe');
    await fs.mkdir(probe);
    let aliases: boolean;
    try {
      try {
        await fs.lstat(path.join(folder, '\u1e9e-PROBE'));
        aliases = true;
      } catch (error) {
        if (!FileSystem.isNotExistError(error as Error)) throw error;
        aliases = false;
      }
    } finally {
      await fs.rm(probe, { recursive: true, force: true });
    }
    if (!aliases) return;
    const locks = await acquireShardOutputLocksAsync(folder, [path.join(folder, 'reports', '\u00df.json')]);
    try {
      await expect(
        acquireShardOutputLocksAsync(folder, [path.join(folder, 'reports', '\u1e9e.json')])
      ).rejects.toThrow(/already owned/);
    } finally {
      releaseShardOutputLocks(locks);
    }
  });

  (hasShortPathAlias ? it : it.skip).each([false, true])(
    'shares ownership through Windows short-path ancestors (output already exists: %s)',
    async (exists) => {
      const buildFolder: string = path.dirname(compiledFolder);
      const output: string = path.join(folder, 'new-parent', '1');
      const relativeOutput: string = path.relative(buildFolder, output);
      const aliasOutput: string = path.join(shortCompiledFolderName!, path.relative(compiledFolder, output));
      if (exists) await fs.mkdir(output, { recursive: true });
      const owner: IJestShardExecution = await prepareJestShardExecutionAsync(
        buildFolder,
        relativeOutput,
        { shardIndex: 1, shardCount: 1 },
        'generation-1'
      );
      executions.push(owner);
      await expect(
        prepareJestShardExecutionAsync(
          buildFolder,
          aliasOutput,
          { shardIndex: 1, shardCount: 1 },
          'generation-1'
        ).then((execution) => {
          executions.push(execution);
          return execution;
        })
      ).rejects.toThrow(/already owned/);
      owner.lock.release();
      const retry: IJestShardExecution = await prepareJestShardExecutionAsync(
        buildFolder,
        aliasOutput,
        { shardIndex: 1, shardCount: 1 },
        'generation-1'
      );
      executions.push(retry);
      expect(retry.lock.filePath).toBe(owner.lock.filePath);
    }
  );

  it('does not block a distinct destination', async () => {
    const owner: IJestShardExecution = await prepareAsync();
    const sibling: IJestShardExecution = await prepareJestShardExecutionAsync(
      folder,
      'shards/2',
      { shardIndex: 2, shardCount: 2 },
      'generation-1'
    );
    executions.push(sibling);
    expect(sibling.lock.filePath).not.toBe(owner.lock.filePath);
    expect(owner.lock.isReleased).toBe(false);
  });

  it('registers disjoint claim sets concurrently without serializing their lifetimes', async () => {
    const [first, second] = await Promise.all([
      acquireShardOutputLocksAsync(folder, [
        path.join(folder, 'one.json'),
        path.join(folder, 'one-coverage')
      ]),
      acquireShardOutputLocksAsync(folder, [path.join(folder, 'two.json'), path.join(folder, 'two-coverage')])
    ]);
    try {
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      await expect(acquireShardOutputLocksAsync(folder, [path.join(folder, 'one.json')])).rejects.toThrow(
        /already owned/
      );
    } finally {
      releaseShardOutputLocks([...first, ...second]);
    }
    expect(
      await fs.readdir(path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME), { withFileTypes: true })
    ).toHaveLength(0);
  });

  it('retries gate contention even when the previous owner has already released the gate', async () => {
    const gate: string = path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME, 'acquire.lock');
    const open: typeof fsSync.openSync = fsSync.openSync;
    let contended: boolean = false;
    const spy = jest.spyOn(fsSync, 'openSync').mockImplementation((filename, flags, mode) => {
      if (filename === gate && !contended) {
        contended = true;
        // The competing owner's release lands after our exclusive open fails, before the retry.
        const descriptor: number = open(filename, flags, mode);
        fsSync.closeSync(descriptor);
        fsSync.unlinkSync(filename);
        throw Object.assign(new Error('Registration gate was occupied'), { code: 'EEXIST' });
      }
      return open(filename, flags, mode);
    });
    try {
      const locks = await acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')]);
      expect(contended).toBe(true);
      releaseShardOutputLocks(locks);
      expect(await fs.readdir(path.dirname(gate))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('removes a newly created lock if its filesystem identity cannot be read', async () => {
    const fstat = fsSync.fstatSync;
    let failed: boolean = false;
    jest.spyOn(fsSync, 'fstatSync').mockImplementation((descriptor, options) => {
      if (!failed) {
        failed = true;
        throw new Error('identity unavailable');
      }
      return fstat(descriptor, options);
    });
    await expect(acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')])).rejects.toThrow(
      'identity unavailable'
    );
    jest.restoreAllMocks();
    expect(await fs.readdir(path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME))).toEqual([]);
    releaseShardOutputLocks(await acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')]));
  });

  it.each([false, true])('excludes ancestor and descendant claim overlap (reverse: %s)', async (reverse) => {
    const parent = path.join(folder, 'reports');
    const child = path.join(parent, 'nested', 'report.json');
    const locks = await acquireShardOutputLocksAsync(folder, [reverse ? child : parent]);
    try {
      await expect(acquireShardOutputLocksAsync(folder, [reverse ? parent : child])).rejects.toThrow(
        /already owned/
      );
    } finally {
      releaseShardOutputLocks(locks);
    }
  });

  it('rejects ancestor and descendant outputs in one registration', async () => {
    const parent = path.join(folder, 'reports');
    const child = path.join(parent, 'nested', 'report.json');
    await expect(acquireShardOutputLocksAsync(folder, [parent, child])).rejects.toThrow(
      /overlap within one operation/
    );
  });

  it('releases every partial claim after a registration write error', async () => {
    const writeFile = fsSync.writeFileSync;
    jest.spyOn(fsSync, 'writeFileSync').mockImplementation((filename, data, options) => {
      if (
        typeof data === 'string' &&
        (JSON.parse(data) as { destination?: string }).destination?.toLowerCase() === 'two.json'
      ) {
        throw new Error('claim registration denied');
      }
      writeFile(filename, data, options);
    });
    const paths = [path.join(folder, 'one.json'), path.join(folder, 'two.json')];
    await expect(acquireShardOutputLocksAsync(folder, paths)).rejects.toThrow('claim registration denied');
    jest.restoreAllMocks();
    expect(
      await fs.readdir(path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME), { withFileTypes: true })
    ).toHaveLength(0);
    releaseShardOutputLocks(await acquireShardOutputLocksAsync(folder, paths));
  });

  it('releases registered claims if the registration gate changes before release', async () => {
    const gate: string = path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME, 'acquire.lock');
    const writeFile = fsSync.writeFileSync;
    jest.spyOn(fsSync, 'writeFileSync').mockImplementation((filename, data, options) => {
      writeFile(filename, data, options);
      if (
        typeof data === 'string' &&
        (JSON.parse(data) as { kind?: string }).kind === 'output' &&
        (JSON.parse(data) as { destination?: string }).destination?.toLowerCase() === 'report.json'
      ) {
        fsSync.unlinkSync(gate);
        writeFile(gate, 'replacement');
      }
    });
    await expect(acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')])).rejects.toThrow(
      /finalize managed shard output ownership registration/
    );
    jest.restoreAllMocks();
    expect(await fs.readdir(path.dirname(gate))).toEqual(['acquire.lock']);
    await fs.unlink(gate);
    releaseShardOutputLocks(await acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')]));
  });

  it('does not unlink a claim that gained another hard link while owned', async () => {
    const locks = await acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')]);
    const link = path.join(folder, 'preserve-claim');
    await fs.link(locks[0].filePath, link);
    const contents = await fs.readFile(link, 'utf8');
    expect(() => locks[0].release()).toThrow(/changed while in use/);
    expect(locks[0].isReleased).toBe(true);
    expect(await fs.readFile(locks[0].filePath, 'utf8')).toBe(contents);
    await expect(acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')])).rejects.toThrow(
      /already owned/
    );
  });

  it('canonicalizes files without creating them and never accepts escaped or reserved destinations', async () => {
    const target = path.join(folder, 'new-parent', 'report.json');
    expect(await resolveShardOutputPathAsync(folder, target, false)).toBe(target);
    expect(await FileSystem.existsAsync(target)).toBe(false);
    await expect(
      resolveShardOutputPathAsync(folder, path.resolve(folder, '..', 'escape'), false)
    ).rejects.toThrow(/below the build folder/);
    await expect(
      resolveShardOutputPathAsync(
        folder,
        path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME, 'report.json'),
        false
      )
    ).rejects.toThrow(/reserved/);
  });

  it('does not reclaim an abandoned registration gate automatically', async () => {
    const locks = path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME);
    await fs.mkdir(locks);
    const gate = path.join(locks, 'acquire.lock');
    await fs.writeFile(gate, 'abandoned');
    await expect(acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')])).rejects.toThrow(
      /remove the ownership file only after confirming/
    );
    expect(await fs.readFile(gate, 'utf8')).toBe('abandoned');
    // This fixture has no owning process; recovery is explicit, never an acquisition side effect.
    await fs.unlink(gate);
    releaseShardOutputLocks(await acquireShardOutputLocksAsync(folder, [path.join(folder, 'report.json')]));
  });

  it('rejects a junction at the lock path without changing its target', async () => {
    const target: string = path.join(folder, 'other-locks');
    await fs.mkdir(target);
    await fs.symlink(target, path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME), 'junction');
    await expect(prepareAsync()).rejects.toThrow(/symbolic link/);
    expect(await fs.readdir(target, { withFileTypes: true })).toHaveLength(0);
  });

  it('rejects hardlinked lock artifacts without modifying the other link', async () => {
    const owner: IJestShardExecution = await prepareAsync();
    owner.lock.release();
    const victim: string = path.join(folder, 'preserve.txt');
    await fs.writeFile(victim, 'preserve');
    await fs.link(victim, owner.lock.filePath);
    await expect(prepareAsync()).rejects.toThrow(/already owned/);
    expect(await fs.readFile(victim, 'utf8')).toBe('preserve');
  });

  it('rejects cacheable output within the reserved ownership namespace', async () => {
    await expect(
      prepareJestShardExecutionAsync(
        folder,
        path.join(SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME, '1'),
        { shardIndex: 1, shardCount: 1 },
        'generation-1'
      )
    ).rejects.toThrow(/reserved/);
  });

  it('does not lose ownership when ordinary preparation outputs are cleaned', async () => {
    const owner: IJestShardExecution = await prepareJestShardExecutionAsync(
      folder,
      'temp/shards/1',
      { shardIndex: 1, shardCount: 1 },
      'generation-1'
    );
    executions.push(owner);
    const tempFolder: string = path.join(folder, 'temp');
    await fs.mkdir(tempFolder, { recursive: true });
    await fs.rm(tempFolder, { recursive: true });
    await expect(
      prepareJestShardExecutionAsync(
        folder,
        'temp/shards/1',
        { shardIndex: 1, shardCount: 1 },
        'generation-1'
      )
    ).rejects.toThrow(/already owned/);
  });

  it('releases preparation ownership on a missing generation', async () => {
    await expect(
      prepareJestShardExecutionAsync(folder, 'shards/1', { shardIndex: 1, shardCount: 1 }, undefined)
    ).rejects.toThrow(/RUSH_SHARD_GENERATION/);
    await prepareAsync();
  });

  it('invalidates standalone publication when cancellation follows the atomic writer check', async () => {
    const owner: IJestShardExecution = await prepareAsync();
    const controller: AbortController = new AbortController();
    const writeManifest = shardManifest.writeShardResultManifestAsync;
    jest.spyOn(shardManifest, 'writeShardResultManifestAsync').mockImplementation(async (...args) => {
      await writeManifest(...args);
      controller.abort();
    });
    await expect(
      completeJestShardExecutionAsync(owner, makeEmptyAggregatedTestResult(), controller.signal)
    ).rejects.toThrow();
    await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    await expect(prepareAsync()).rejects.toThrow(/already owned/);
  });

  it.each([2, 4])(
    'cancels the real task hook %s microtasks after rename without a publication completion message',
    async (microtasks) => {
      await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => expect(1).toBe(1));");
      const result: ICliResult = await runJestTaskHookInChildAsync(folder, 'cancelled-task', microtasks);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('Cancelled after manifest rename');
      expect(result.output).not.toContain('Shard 1/1:');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
      await prepareAsync(folder, 'test/cancelled-task');
    },
    60000
  );

  it.each(['configuration', 'runCLI'])(
    'releases real task ownership after %s failure',
    async (failure) => {
      if (failure === 'configuration') {
        await fs.writeFile(path.join(folder, 'config', 'jest.config.json'), '{invalid');
      } else {
        await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
        await fs.writeFile(
          path.join(folder, 'setup.js'),
          "module.exports = () => { throw new Error('setup failed'); };"
        );
        await writeConfigAsync(folder, { setupFiles: ['<rootDir>/setup.js'] });
      }
      const result: ICliResult = await runJestTaskHookInChildAsync(folder, 'failed-task');
      expect(result.code).not.toBe(0);
      expect(result.output).not.toContain('Shard 1/1:');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
      await prepareAsync(folder, 'test/failed-task');
    },
    60000
  );

  it('fails closed on ownership abandoned by a terminated task', async () => {
    await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
    await fs.writeFile(path.join(folder, 'setup.js'), 'module.exports = () => process.exit(7);');
    await writeConfigAsync(folder, { setupFiles: ['<rootDir>/setup.js'] });
    const result: ICliResult = await runJestTaskHookInChildAsync(folder, 'terminated-task');
    expect(result.code).toBe(7);
    await expect(prepareAsync()).rejects.toThrow(/remove the ownership file only after confirming/);
    await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
  }, 60000);

  it('retains the producer binding in cached output after active ownership is released', async () => {
    const owner: IJestShardExecution = await prepareAsync(folder, 'temp/test/first');
    const manifest = await completeJestShardExecutionAsync(
      owner,
      makeEmptyAggregatedTestResult(),
      new AbortController().signal
    );
    owner.lock.release();
    await fs.rm(path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME), { recursive: true });
    await expect(prepareAsync(folder, 'temp/test/second')).rejects.toThrow(/already bound to producer/);
    expect(await readShardResultManifestAsync(outputFolder)).toEqual(manifest);
    expect(manifest.payload).toMatchObject({ producerId: 'temp/test/first' });
    expect(await fs.readdir(outputFolder, { withFileTypes: true })).toHaveLength(1);
    await prepareAsync(folder, 'temp/test/first');
  });

  it('does not adopt a valid restored same-generation result without a producer identity', async () => {
    const owner: IJestShardExecution = await prepareAsync(folder, 'temp/test/first');
    const manifest = await completeJestShardExecutionAsync(
      owner,
      makeEmptyAggregatedTestResult(),
      new AbortController().signal
    );
    owner.lock.release();
    const legacy: string = JSON.stringify({
      ...manifest,
      payload: { ...(manifest.payload as IJestShardPayload), producerId: undefined }
    });
    await fs.writeFile(getShardManifestPath(outputFolder), legacy);
    await expect(prepareAsync(folder, 'temp/test/first')).rejects.toThrow(/Missing producer identity/);
    expect(await fs.readFile(getShardManifestPath(outputFolder), 'utf8')).toBe(legacy);
  });

  it.each(['JSON', 'envelope', 'payload'])(
    'invalidates corrupt %s rather than trusting its producer',
    async (kind) => {
      const owner: IJestShardExecution = await prepareAsync(folder, 'temp/test/first');
      const manifest = await completeJestShardExecutionAsync(
        owner,
        makeEmptyAggregatedTestResult(),
        new AbortController().signal
      );
      owner.lock.release();
      const contents: string =
        kind === 'JSON'
          ? 'not JSON'
          : JSON.stringify(
              kind === 'envelope'
                ? { ...manifest, version: 999 }
                : { ...manifest, payload: { ...(manifest.payload as IJestShardPayload), passed: 3 } }
            );
      await fs.writeFile(getShardManifestPath(outputFolder), contents);
      await prepareAsync(folder, 'temp/test/retry');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    }
  );

  it('propagates marker read errors without treating them as corrupt results', async () => {
    const owner: IJestShardExecution = await prepareAsync();
    const manifest = await completeJestShardExecutionAsync(
      owner,
      makeEmptyAggregatedTestResult(),
      new AbortController().signal
    );
    owner.lock.release();
    const denied: Error = Object.assign(new Error('marker access denied'), { code: 'EACCES' });
    jest.spyOn(fs, 'readFile').mockRejectedValueOnce(denied);
    await expect(prepareAsync()).rejects.toBe(denied);
    jest.restoreAllMocks();
    expect(await readShardResultManifestAsync(outputFolder)).toEqual(manifest);
    await prepareAsync();
  });

  it.each(['temp/test/first', 'temp/test/second'])(
    'permits producer %s in a new generation',
    async (producerId) => {
      const owner: IJestShardExecution = await prepareAsync(folder, 'temp/test/first');
      await completeJestShardExecutionAsync(
        owner,
        makeEmptyAggregatedTestResult(),
        new AbortController().signal
      );
      owner.lock.release();
      const next: IJestShardExecution = await prepareJestShardExecutionAsync(
        folder,
        'shards/1',
        { shardIndex: 1, shardCount: 1 },
        'generation-2',
        producerId
      );
      executions.push(next);
      expect(next.generation).toBe('generation-2');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    }
  );

  it.each(['../first', '/absolute', 'C:\\absolute', 'test//first', ' '])(
    'rejects nonportable producer identity %s',
    async (producerId) => {
      await expect(
        prepareJestShardExecutionAsync(
          folder,
          'shards/1',
          { shardIndex: 1, shardCount: 1 },
          'generation-1',
          producerId
        )
      ).rejects.toThrow(/producer identity/);
    }
  );

  it('rejects a dependent Jest task sharing its predecessor output in the real Heft phase', async () => {
    await fs.writeFile(path.join(folder, 'failure.test.js'), "test('fails', () => expect(1).toBe(2));");
    await fs.writeFile(
      path.join(folder, 'pass.test.js'),
      "test('passes', () => { require('fs').writeFileSync(require('path').join(__dirname, 'second-ran'), ''); });"
    );
    await writeConfigAsync(folder, { testMatch: ['<rootDir>/failure.test.js'], collectCoverage: false });
    await fs.copyFile(
      path.join(folder, 'config', 'jest.config.json'),
      path.join(folder, 'config', 'first.config.json')
    );
    await writeConfigAsync(folder, { testMatch: ['<rootDir>/pass.test.js'], collectCoverage: false });
    await fs.writeFile(
      path.join(folder, 'config', 'heft.json'),
      JSON.stringify({
        phasesByName: {
          test: {
            tasksByName: {
              first: {
                taskPlugin: {
                  pluginPackage: '@rushstack/heft-jest-plugin',
                  options: {
                    configurationPath: 'config/first.config.json',
                    disableConfigurationModuleResolution: true
                  }
                }
              },
              second: {
                taskDependencies: ['first'],
                taskPlugin: {
                  pluginPackage: '@rushstack/heft-jest-plugin',
                  options: { disableConfigurationModuleResolution: true }
                }
              }
            }
          }
        }
      })
    );
    const result: ICliResult = await runHeftAsync(folder, [
      '--shard=1/1',
      '--shard-output-directory=shards/1'
    ]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('already bound to producer');
    expect(await readShardResultManifestAsync(outputFolder)).toMatchObject({
      itemCount: 1,
      diagnosticCount: 1
    });
    expect(await FileSystem.existsAsync(path.join(folder, 'second-ran'))).toBe(false);
  }, 120000);

  it('allows a real task to retry its own output in the same generation', async () => {
    const testFile: string = path.join(folder, 'retry.test.js');
    await fs.writeFile(testFile, "test('fails', () => expect(1).toBe(2));");
    expect((await runJestTaskHookInChildAsync(folder, 'retry-task')).code).toBe(0);
    const firstManifest = await readShardResultManifestAsync(outputFolder);
    expect(firstManifest).toMatchObject({ diagnosticCount: 1 });
    await fs.writeFile(testFile, "test('passes', () => expect(1).toBe(1));");
    expect((await runJestTaskHookInChildAsync(folder, 'retry-task')).code).toBe(0);
    const secondManifest = await readShardResultManifestAsync(outputFolder);
    expect(secondManifest).toMatchObject({
      generation: firstManifest.generation,
      diagnosticCount: 0
    });
    expect(secondManifest.producerAttempt).not.toBe(firstManifest.producerAttempt);
  }, 120000);

  it('rejects a distinct managed task in another process without overwriting the first verdict', async () => {
    await fs.writeFile(path.join(folder, 'failure.test.js'), "test('fails', () => expect(1).toBe(2));");
    await fs.writeFile(
      path.join(folder, 'setup.js'),
      "const fs = require('fs'); const path = require('path'); module.exports = async () => {" +
        "fs.writeFileSync(path.join(__dirname, 'owner-ready'), '');" +
        "while (!fs.existsSync(path.join(__dirname, 'owner-release'))) " +
        'await new Promise(resolve => setTimeout(resolve, 10)); };'
    );
    await writeConfigAsync(folder, { setupFiles: ['<rootDir>/setup.js'] });
    const first: Promise<ICliResult> = runJestTaskHookInChildAsync(folder, 'first-operation');
    try {
      const deadline: number = Date.now() + 45000;
      while (!(await FileSystem.existsAsync(path.join(folder, 'owner-ready')))) {
        if (Date.now() > deadline) throw new Error('First managed task did not enter its setup file.');
        await Async.sleepAsync(20);
      }
      const second: ICliResult = await runJestTaskHookInChildAsync(folder, 'second-operation');
      expect(second.code).not.toBe(0);
      expect(second.output).toContain('already owned by another task or process');
      expect(second.output).not.toContain('verdict deferred to collator');
    } finally {
      await fs.writeFile(path.join(folder, 'owner-release'), '');
      const firstResult: ICliResult = await first;
      expect(firstResult).toEqual({
        code: 0,
        output: expect.stringContaining('verdict deferred to collator')
      });
    }
    const manifest = await readShardResultManifestAsync(outputFolder);
    expect(manifest).toMatchObject({ itemCount: 1, diagnosticCount: 1 });
    expect(await fs.readFile(getShardManifestPath(outputFolder), 'utf8')).toContain('"failed":1');
  }, 120000);
});
