// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  acquireShardOutputLocksAsync,
  SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME,
  type IShardOutputLock
} from '../ShardOutputOwnership';
import { writeShardFileAtomicallyAsync } from '../ShardFileSystem';

describe('Heft output claims and attempt fences', () => {
  let folder: string;
  let output: string;
  const locks: IShardOutputLock[] = [];

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(__dirname, 'shard-claims-'));
    output = path.join(folder, 'result.json');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const lock of locks) if (!lock.isReleased) lock.release();
    locks.length = 0;
    await fs.rm(folder, { recursive: true, force: true });
  });

  async function acquireAsync(signal?: AbortSignal): Promise<IShardOutputLock> {
    const [lock] = await acquireShardOutputLocksAsync(
      folder,
      [output],
      { project: 'example', phase: 'test', task: 'jest', shardIndex: 2, shardCount: 4, generation: 'G' },
      signal
    );
    locks.push(lock);
    return lock;
  }

  it('reports the current holder without stealing its output claim', async () => {
    const lock = await acquireAsync();
    const metadata = JSON.parse(await fs.readFile(lock.filePath, 'utf8'));
    expect(metadata).toMatchObject({
      version: 2,
      kind: 'output',
      destination: 'result.json',
      project: 'example',
      phase: 'test',
      task: 'jest',
      shardIndex: 2,
      shardCount: 4,
      generation: 'G',
      attemptId: lock.attemptId,
      pid: process.pid,
      host: expect.any(String),
      acquiredAt: expect.any(String),
      processStartedAt: expect.any(String)
    });
    await expect(acquireAsync()).rejects.toThrow(lock.attemptId);
    await expect(acquireAsync()).rejects.toThrow(/state=contended retryCount=0.*claimAgeMs/);
    expect(await fs.readFile(lock.filePath, 'utf8')).toBe(JSON.stringify(metadata));
  });

  it('revokes A before releasing its claim and rejects a late A promotion after B starts', async () => {
    const controller = new AbortController();
    const first = await acquireAsync(controller.signal);
    controller.abort();
    expect(first.state).toBe('revoked');
    await expect(acquireAsync()).rejects.toThrow(/already owned/);
    first.release();
    const second = await acquireAsync();
    expect(second.attemptId).not.toBe(first.attemptId);
    await writeShardFileAtomicallyAsync(output, 'B', undefined, second);

    // A queued continuation still carries A's capability, even if it loses the abort signal.
    await expect(writeShardFileAtomicallyAsync(output, 'late A', undefined, first)).rejects.toThrow(
      /released/
    );
    expect(await fs.readFile(output, 'utf8')).toBe('B');
    expect(await fs.readdir(folder)).toEqual(
      expect.arrayContaining(['result.json', SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME])
    );
    expect((await fs.readdir(folder)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not release a claim between the final fence check and manifest promotion', async () => {
    const lock = await acquireAsync();
    const rename = fsSync.renameSync;
    jest.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      expect(lock.state).toBe('publishing');
      expect(() => lock.release()).toThrow(/Cannot release a publishing/);
      rename(source, destination);
    });
    await writeShardFileAtomicallyAsync(output, 'complete', undefined, lock);
    expect(lock.state).toBe('held');
    expect(await fs.readFile(output, 'utf8')).toBe('complete');
  });

  it('does not close a reused descriptor when a released claim is released again', async () => {
    const first = await acquireAsync();
    first.release();
    const descriptor = fsSync.openSync(output, 'w');
    try {
      expect(() => first.release()).toThrow(/already released/);
      fsSync.writeSync(descriptor, 'still owned by the caller');
    } finally {
      fsSync.closeSync(descriptor);
    }
    expect(await fs.readFile(output, 'utf8')).toBe('still owned by the caller');
  });

  it('invalidates a just-promoted result when cancellation arrives before returning to the caller', async () => {
    const controller = new AbortController();
    const lock = await acquireAsync(controller.signal);
    const rename = fsSync.renameSync;
    jest.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      rename(source, destination);
      controller.abort();
    });
    await expect(
      writeShardFileAtomicallyAsync(output, 'cancelled', controller.signal, lock)
    ).rejects.toThrow();
    expect(lock.state).toBe('revoked');
    await expect(fs.stat(output)).rejects.toThrow(/ENOENT/);
    await expect(acquireAsync()).rejects.toThrow(/already owned/);
  });

  it('reports bounded registration exhaustion and preserves an abandoned gate for verified cleanup', async () => {
    const lock = await acquireAsync();
    const metadata = JSON.parse(await fs.readFile(lock.filePath, 'utf8'));
    lock.release();
    const gate = path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME, 'acquire.lock');
    metadata.kind = 'registration';
    metadata.acquiredAt = '2000-01-01T00:00:00.000Z';
    const contents = JSON.stringify(metadata);
    await fs.writeFile(gate, contents);
    await expect(acquireAsync()).rejects.toThrow(
      /state=retry-exhausted retryCount=\d+ retryDeadline=.*Never steal a claim based only on PID or age/
    );
    expect(await fs.readFile(gate, 'utf8')).toBe(contents);
    // This test owns the synthetic gate; production recovery requires verified process termination.
    await fs.unlink(gate);
    expect((await acquireAsync()).state).toBe('held');
  });
});
