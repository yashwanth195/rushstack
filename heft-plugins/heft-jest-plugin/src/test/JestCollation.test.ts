// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';
import type { IShardCollationContext } from '@rushstack/heft/lib/sharding/IShardCollationAdapter';
import { validateShardResults } from '@rushstack/heft/lib/sharding/ShardCollation';
import { collateShardsAsync } from '@rushstack/heft/lib/sharding/ShardCollationRunner';
import { writeShardResultManifestAsync } from '@rushstack/heft/lib/sharding/ShardResultManifest';
import { StringBufferTerminalProvider, Terminal } from '@rushstack/terminal';

import { JestCollationAdapter, mergeJestShardResults, type IJestCollatorOptions } from '../JestCollation';
import { getJestShardCounts, type IJestShardPayload } from '../JestShardPayload';
import { disabledJestCoverage } from '../JestCoverage';

function createManifest(index: number, failed: boolean = false): IShardResultManifest {
  const payload: IJestShardPayload = {
    version: 2,
    passWithNoTests: true,
    coverage: disabledJestCoverage(),
    passed: failed ? 0 : 1,
    failed: failed ? 1 : 0,
    skipped: 0,
    todo: 0,
    failedSuites: failed ? 1 : 0,
    runtimeErrorSuites: 0,
    snapshotFailure: false,
    success: !failed,
    failureReasons: failed ? ['failed-tests', 'failed-suites', 'jest-unsuccessful'] : [],
    testFiles: [
      {
        path: `test-${index}.js`,
        passed: failed ? 0 : 1,
        failed: failed ? 1 : 0,
        skipped: 0,
        todo: 0,
        failureMessage: null,
        executionError: null,
        snapshotFailure: false,
        failures: failed ? [{ testName: 'fails', messages: ['actual assertion failure'] }] : []
      }
    ]
  };
  return {
    version: 1,
    shardIndex: index,
    shardCount: 2,
    generation: 'current',
    producerAttempt: `attempt-${index}`,
    status: 'completed',
    workload: 'jest',
    startedAt: '2026-09-14T00:00:00.000Z',
    durationMs: 1,
    ...getJestShardCounts(payload),
    payload
  };
}

describe('Jest collation adapter', () => {
  let folder: string;
  let terminalProvider: StringBufferTerminalProvider;
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(__dirname, 'jest-collation-'));
    terminalProvider = new StringBufferTerminalProvider(false);
  });
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  function createAdapter(options?: IJestCollatorOptions): JestCollationAdapter {
    return new JestCollationAdapter(folder, new Terminal(terminalProvider), options);
  }
  function context(signal: AbortSignal = new AbortController().signal): IShardCollationContext {
    return { shardParentFolderPath: path.join(folder, 'shards'), abortSignal: signal };
  }

  it('keeps a published report exclusively owned until cancellation cleanup finishes', async () => {
    for (const index of [1, 2]) {
      await writeShardResultManifestAsync(path.join(folder, 'shards', String(index)), createManifest(index));
    }
    const options = {
      buildFolderPath: folder,
      shardParentFolderPath: path.join(folder, 'shards'),
      shardCount: 2,
      expectedGeneration: 'current'
    };
    const controller = new AbortController();
    let published!: () => void;
    let finish!: () => void;
    const publication = new Promise<void>((resolve) => {
      published = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const adapter = createAdapter();
    const originalAcquire = adapter.acquireAsync.bind(adapter);
    jest.spyOn(adapter, 'acquireAsync').mockImplementation(async (...args) => {
      const session = await originalAcquire(...args);
      return {
        ...session,
        collateAsync: async (result) => {
          const verdict = await session.collateAsync(result);
          published();
          await completion;
          return verdict;
        }
      };
    });
    const first = collateShardsAsync(options, adapter, controller.signal);
    const cancelled = expect(first).rejects.toThrow('cancel first');
    try {
      await publication;
      const filename = path.join(folder, 'temp', 'jest-collated.json');
      const contents = await fs.readFile(filename, 'utf8');
      await expect(
        collateShardsAsync(options, createAdapter(), new AbortController().signal)
      ).rejects.toThrow(/already owned/);
      expect(await fs.readFile(filename, 'utf8')).toBe(contents);
    } finally {
      controller.abort(new Error('cancel first'));
      finish();
      await cancelled;
      jest.restoreAllMocks();
    }
    await collateShardsAsync(options, createAdapter(), new AbortController().signal);
    expect(
      JSON.parse(await fs.readFile(path.join(folder, 'temp', 'jest-collated.json'), 'utf8'))
    ).toMatchObject({
      success: true,
      generation: 'current'
    });
  });

  it('persists failure details and portable identities with deterministic file ordering', async () => {
    const result = validateShardResults([createManifest(2, true), createManifest(1)], 2);
    const adapter = createAdapter({ outputDirectory: 'reports', reportFilename: 'results.json' });
    await adapter.prepareAsync(context());
    await adapter.collateAsync(result, context());
    const report = JSON.parse(await fs.readFile(path.join(folder, 'reports', 'results.json'), 'utf8'));
    expect(report).toMatchObject({
      success: false,
      diagnosticCount: 1,
      itemCount: 2,
      generation: 'current',
      totals: { passed: 1, failed: 1, failedSuites: 1 }
    });
    expect(report.testFiles.map((file: { path: string }) => file.path)).toEqual(['test-1.js', 'test-2.js']);
    expect(terminalProvider.getErrorOutput()).toContain('actual assertion failure');
    expect(terminalProvider.getOutput()).toContain('1 passed, 1 failed');
    expect(await fs.readdir(path.join(folder, 'reports'))).toEqual(['results.json']);
  });

  it('rejects duplicate identities and mismatched envelope counters', () => {
    const first = createManifest(1);
    const duplicate = { ...first, shardIndex: 2 };
    expect(() => mergeJestShardResults(validateShardResults([first, duplicate], 2))).toThrow(/Duplicate/);
    expect(() =>
      mergeJestShardResults(validateShardResults([first, { ...createManifest(2), itemCount: 5 }], 2))
    ).toThrow(/counters do not match/);
  });

  it.each([
    { passWithNoTests: false, success: false, diagnosticCount: 1 },
    { passWithNoTests: true, success: true, diagnosticCount: 0 }
  ])(
    'applies the whole-suite empty selection policy when passWithNoTests is $passWithNoTests',
    ({ passWithNoTests, success, diagnosticCount }) => {
      const manifests: IShardResultManifest[] = [createManifest(1), createManifest(2)];
      for (const manifest of manifests) {
        const payload: IJestShardPayload = manifest.payload as IJestShardPayload;
        payload.passWithNoTests = passWithNoTests;
        payload.testFiles = [];
        payload.passed = 0;
        manifest.itemCount = 0;
      }

      expect(mergeJestShardResults(validateShardResults(manifests, 2))).toMatchObject({
        passWithNoTests,
        success,
        diagnosticCount,
        itemCount: 0,
        testFiles: []
      });
    }
  );

  it('rejects inconsistent empty selection policies across siblings', () => {
    const manifests: IShardResultManifest[] = [createManifest(1), createManifest(2)];
    (manifests[1].payload as IJestShardPayload).passWithNoTests = false;

    expect(() => mergeJestShardResults(validateShardResults(manifests, 2))).toThrow(/passWithNoTests policy/);
  });

  it('rejects unsafe summed skipped counts even though executed counts are small', () => {
    const manifests = [createManifest(1), createManifest(2)];
    for (const manifest of manifests) {
      const payload = manifest.payload as IJestShardPayload;
      payload.skipped = payload.testFiles[0].skipped = Number.MAX_SAFE_INTEGER;
    }
    expect(() => mergeJestShardResults(validateShardResults(manifests, 2))).toThrow(/safe integer range/);
  });

  it('retains per-shard unexplained and snapshot diagnostics, not just failed assertion counts', () => {
    const manifests = [createManifest(1), createManifest(2)];
    const unexplained = manifests[0].payload as IJestShardPayload;
    unexplained.success = false;
    unexplained.failureReasons = ['jest-unsuccessful'];
    manifests[0].diagnosticCount = 1;
    const snapshot = manifests[1].payload as IJestShardPayload;
    snapshot.snapshotFailure = true;
    snapshot.success = false;
    snapshot.failureReasons = ['snapshot-failure', 'jest-unsuccessful'];
    manifests[1].diagnosticCount = 1;
    expect(mergeJestShardResults(validateShardResults(manifests, 2))).toMatchObject({
      success: false,
      diagnosticCount: 2,
      itemCount: 2,
      snapshotFailure: true,
      totals: { failed: 0 },
      shards: [
        { failureReasons: ['jest-unsuccessful'] },
        { failureReasons: ['snapshot-failure', 'jest-unsuccessful'] }
      ]
    });
  });

  it('invalidates a prior report before propagating cancellation', async () => {
    await fs.mkdir(path.join(folder, 'temp'));
    await fs.writeFile(path.join(folder, 'temp', 'jest-collated.json'), '{"success":true}');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const adapter = createAdapter();
    await expect(adapter.prepareAsync(context(controller.signal))).rejects.toThrow('cancelled');
    expect(await fs.readdir(path.join(folder, 'temp'))).toEqual([]);
    await expect(
      adapter.collateAsync(
        validateShardResults([createManifest(1), createManifest(2)], 2),
        context(controller.signal)
      )
    ).rejects.toThrow('cancelled');
    expect(await fs.readdir(path.join(folder, 'temp'))).toEqual([]);
  });

  it('propagates a publication error without leaving staging files or a success report', async () => {
    const adapter = createAdapter();
    await adapter.prepareAsync(context());
    await fs.mkdir(path.join(folder, 'temp', 'jest-collated.json'), { recursive: true });
    await expect(
      adapter.collateAsync(validateShardResults([createManifest(1), createManifest(2)], 2), context())
    ).rejects.toThrow();
    expect(await fs.readdir(path.join(folder, 'temp'))).toEqual(['jest-collated.json']);
    expect((await fs.stat(path.join(folder, 'temp', 'jest-collated.json'))).isDirectory()).toBe(true);
    expect(terminalProvider.getOutput()).not.toContain('Jest collated');
  });

  it.each(['shards', 'shards/1', '../outside', '.'])(
    'rejects unsafe output directory %s',
    async (outputDirectory) => {
      await expect(createAdapter({ outputDirectory }).prepareAsync(context())).rejects.toThrow(
        /overlap|below the build/
      );
    }
  );

  it.each([
    '../shard-manifest.json',
    'shard-manifest.json',
    'dir/report.json',
    'dir\\report.json',
    'C:report.json'
  ])('rejects unsafe report filename %s', (reportFilename) => {
    expect(() => createAdapter({ reportFilename })).toThrow(/single JSON filename/);
  });

  it('does not unlink or write through report junctions or hard links', async () => {
    await fs.mkdir(path.join(folder, 'shards', '1'), { recursive: true });
    const input: string = path.join(folder, 'shards', '1', 'shard-manifest.json');
    await fs.writeFile(input, 'input');
    await fs.symlink(path.join(folder, 'shards', '1'), path.join(folder, 'alias'), 'junction');
    await expect(createAdapter({ outputDirectory: 'alias' }).prepareAsync(context())).rejects.toThrow(
      /symbolic link/
    );
    await fs.mkdir(path.join(folder, 'temp'));
    await fs.link(input, path.join(folder, 'temp', 'jest-collated.json'));
    await expect(createAdapter().prepareAsync(context())).rejects.toThrow(/hard link/);
    expect(await fs.readFile(input, 'utf8')).toBe('input');
  });
});
