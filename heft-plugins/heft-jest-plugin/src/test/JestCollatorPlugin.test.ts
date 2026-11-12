// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';
import {
  getShardManifestPath,
  readShardResultManifestAsync
} from '@rushstack/heft/lib/sharding/ShardResultManifest';

import type { IJestCollatedReport, IJestCollatorOptions } from '../JestCollation';
import type { IJestShardPayload } from '../JestShardPayload';
import { createFixtureAsync, runHeftCommandAsync, type ICliResult } from './JestShardTestHelpers';

const COLLATE_ARGS: string[] = ['--shard-parent-folder=shards', '--shard-count=2'];

async function configureCollatorAsync(folder: string, options?: IJestCollatorOptions): Promise<void> {
  await fs.writeFile(
    path.join(folder, 'config', 'heft.json'),
    JSON.stringify({
      phasesByName: {
        'test-prepare': { cleanFiles: [{ sourcePath: 'temp' }], tasksByName: {} },
        test: { tasksByName: { jest: { taskPlugin: { pluginPackage: '@rushstack/heft-jest-plugin' } } } },
        'test-shard': {
          phaseDependencies: ['test-prepare'],
          tasksByName: {
            jest: { taskPlugin: { pluginPackage: '@rushstack/heft-jest-plugin', pluginName: 'jest-plugin' } }
          }
        },
        'test-collate': {
          phaseDependencies: ['test-prepare'],
          tasksByName: {
            collate: {
              taskPlugin: {
                pluginPackage: '@rushstack/heft-jest-plugin',
                pluginName: 'jest-collator-plugin',
                options
              }
            },
            downstream: {
              taskDependencies: ['collate'],
              taskPlugin: {
                pluginPackage: '@rushstack/heft',
                pluginName: 'copy-files-plugin',
                options: {
                  copyOperations: [
                    {
                      sourcePath: 'temp',
                      destinationFolders: ['downstream'],
                      includeGlobs: ['jest-collated.json']
                    }
                  ]
                }
              }
            }
          }
        }
      }
    })
  );
}

describe('Jest collator (real workspace Heft tasks)', () => {
  let fixture: string;
  let folder: string;
  let baseline: IShardResultManifest[];

  beforeAll(async () => {
    fixture = await createFixtureAsync();
    await configureCollatorAsync(fixture);
    await fs.mkdir(path.join(fixture, 'temp'));
    await fs.writeFile(path.join(fixture, 'temp', 'preparation-sentinel'), 'old output');
    const preparation = await runHeftCommandAsync(fixture, [
      'run',
      '--only',
      'test-prepare',
      '--',
      '--clean'
    ]);
    expect(preparation.code).toBe(0);
    await expect(fs.readFile(path.join(fixture, 'temp', 'preparation-sentinel'))).rejects.toThrow(/ENOENT/);
    await fs.writeFile(path.join(fixture, 'one.test.js'), "test('passes', () => expect(1).toBe(1));");
    baseline = [];
    // Real Jest partitions: one executed test and one genuinely empty shard, not fabricated success.
    for (const index of [1, 2]) {
      const result = await runHeftCommandAsync(
        fixture,
        [
          'run',
          '--only',
          'test-shard',
          '--',
          '--disable-code-coverage',
          `--shard=${index}/2`,
          `--shard-output-directory=temp/shards/${index}`
        ],
        'generation-1'
      );
      expect(result).toEqual({ code: 0, output: expect.stringContaining('verdict deferred to collator') });
      baseline.push(await readShardResultManifestAsync(path.join(fixture, 'temp', 'shards', String(index))));
    }
    expect(baseline.map((manifest) => manifest.itemCount).sort()).toEqual([0, 1]);
  }, 180000);
  afterAll(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
  });

  beforeEach(async () => {
    folder = await createFixtureAsync();
    await configureCollatorAsync(folder);
    for (const manifest of baseline) {
      const shardFolder: string = path.join(folder, 'shards', String(manifest.shardIndex));
      await fs.mkdir(shardFolder, { recursive: true });
      await fs.writeFile(getShardManifestPath(shardFolder), JSON.stringify(manifest));
    }
    await fs.mkdir(path.join(folder, 'temp'));
    await fs.writeFile(path.join(folder, 'temp', 'jest-collated.json'), '{"success":true,"old":true}');
    await fs.writeFile(path.join(folder, 'temp', 'keep.json'), 'keep');
  });
  afterEach(async () => {
    if (folder) await fs.rm(folder, { recursive: true, force: true });
  });

  async function runCollatorAsync(generation: string | undefined = 'generation-1'): Promise<ICliResult> {
    return await runHeftCommandAsync(
      folder,
      ['run', '--only', 'test-collate', '--', ...COLLATE_ARGS],
      generation
    );
  }
  async function readReportAsync(): Promise<IJestCollatedReport> {
    return JSON.parse(await fs.readFile(path.join(folder, 'temp', 'jest-collated.json'), 'utf8'));
  }
  async function expectNoReportAsync(): Promise<void> {
    await expect(fs.readFile(path.join(folder, 'temp', 'jest-collated.json'))).rejects.toThrow(/ENOENT/);
    expect(await fs.readFile(path.join(folder, 'temp', 'keep.json'), 'utf8')).toBe('keep');
  }

  it('rejects an absent generation instead of inferring it from matching manifests', async () => {
    const result = await runHeftCommandAsync(folder, [
      'run',
      '--only',
      'test-collate',
      '--',
      ...COLLATE_ARGS
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('RUSH_SHARD_GENERATION');
    await expectNoReportAsync();
  }, 180000);

  it('collates complete managed shards, runs ordered downstream tasks, and replaces a stale report', async () => {
    const result = await runCollatorAsync();
    expect(result).toEqual({
      code: 0,
      output: expect.stringContaining('Jest collated 2 shards: 1 passed, 0 failed')
    });
    const report = await readReportAsync();
    expect(report).toMatchObject({
      success: true,
      generation: 'generation-1',
      itemCount: 1,
      diagnosticCount: 0
    });
    expect(report.testFiles.map((file) => file.path)).toEqual(['one.test.js']);
    expect(
      JSON.parse(await fs.readFile(path.join(folder, 'downstream', 'jest-collated.json'), 'utf8'))
    ).toEqual(report);
    expect((await fs.readdir(path.join(folder, 'temp'))).sort()).toEqual([
      'jest-collated.json',
      'keep.json',
      'test-collate'
    ]);
  }, 180000);

  it('retains the merged failure report and fails Heft only after the managed test completed', async () => {
    const occupied = baseline.find((manifest) => manifest.itemCount > 0)!;
    await fs.writeFile(
      path.join(folder, 'one.test.js'),
      "test('real failure', () => expect('actual').toBe('expected')); test.skip('skip', () => {}); test.todo('todo');"
    );
    const shardResult = await runHeftCommandAsync(
      folder,
      [
        'run',
        '--only',
        'test-shard',
        '--',
        '--max-workers=1',
        '--disable-code-coverage',
        `--shard=${occupied.shardIndex}/2`,
        `--shard-output-directory=shards/${occupied.shardIndex}`
      ],
      'generation-1'
    );
    expect(shardResult).toEqual({ code: 0, output: expect.stringContaining('verdict deferred to collator') });
    const result = await runCollatorAsync();
    expect(result.code).toBe(1);
    expect(result.output).toContain('Sharded run failed with 1 diagnostics');
    expect(result.output).toContain('real failure');
    expect(result.output).toContain('expected');
    expect(result.output).toContain('0 passed, 1 failed, 1 skipped, 1 todo');
    expect(await readReportAsync()).toMatchObject({
      success: false,
      itemCount: 1,
      diagnosticCount: 1,
      totals: { passed: 0, failed: 1, skipped: 1, todo: 1 }
    });
    await expect(fs.readFile(path.join(folder, 'downstream', 'jest-collated.json'))).rejects.toThrow(
      /ENOENT/
    );
  }, 180000);

  it.each([
    ['missing', /no result was found/],
    ['corrupt', /Error reading/],
    ['duplicate-index', /results claim to be shard/],
    ['mismatched-count', /ran as part of/],
    ['mixed-generation', /different runs/],
    ['uniform-stale', /current RUSH_SHARD_GENERATION/],
    ['mixed-workload', /mixed workloads/],
    ['wrong-workload', /completed Jest shard/],
    ['duplicate-file', /Duplicate Jest test file/],
    ['bad-payload', /JSON validation failed/],
    ['bad-counters', /counters do not match/],
    ['harness-failure', /failed to run at all/]
  ])(
    'fails closed and invalidates the prior success report: %s',
    async (scenario, message) => {
      const manifests: IShardResultManifest[] = structuredClone(baseline);
      const occupied = manifests.find((manifest) => manifest.itemCount > 0)!;
      const empty = manifests.find((manifest) => manifest.itemCount === 0)!;
      const emptyFolder: string = path.join(folder, 'shards', String(empty.shardIndex));
      switch (scenario) {
        case 'missing':
          await fs.unlink(getShardManifestPath(emptyFolder));
          break;
        case 'corrupt':
          await fs.writeFile(getShardManifestPath(emptyFolder), '{invalid');
          break;
        case 'duplicate-index':
          await fs.mkdir(path.join(folder, 'shards', 'duplicate'));
          await fs.writeFile(
            getShardManifestPath(path.join(folder, 'shards', 'duplicate')),
            JSON.stringify(occupied)
          );
          break;
        case 'mismatched-count':
          empty.shardCount = 3;
          break;
        case 'mixed-generation':
          empty.generation = 'other';
          break;
        case 'uniform-stale':
          for (const manifest of manifests) manifest.generation = 'previous';
          break;
        case 'mixed-workload':
          empty.workload = 'lint';
          break;
        case 'wrong-workload':
          for (const manifest of manifests) manifest.workload = 'lint';
          break;
        case 'duplicate-file':
          empty.payload = occupied.payload;
          empty.itemCount = occupied.itemCount;
          break;
        case 'bad-payload':
          occupied.payload = { version: 99 };
          break;
        case 'bad-counters':
          occupied.itemCount++;
          break;
        case 'harness-failure':
          occupied.status = 'harness-failure';
          break;
        default:
          throw new Error(`Unknown scenario ${scenario}`);
      }
      if (scenario !== 'missing' && scenario !== 'corrupt') {
        for (const manifest of manifests) {
          await fs.writeFile(
            getShardManifestPath(path.join(folder, 'shards', String(manifest.shardIndex))),
            JSON.stringify(manifest)
          );
        }
      }
      const result = await runCollatorAsync();
      expect(result.code).toBe(1);
      expect(result.output).toMatch(message);
      expect(result.output).not.toContain('Jest collated');
      await expectNoReportAsync();
    },
    180000
  );

  it('publishes a failed report when the complete suite is empty and passWithNoTests is false', async () => {
    const emptyManifests: IShardResultManifest[] = structuredClone(baseline);
    const emptyPayload: IJestShardPayload = structuredClone(
      emptyManifests.find((candidate) => candidate.itemCount === 0)!.payload as IJestShardPayload
    );
    emptyPayload.passWithNoTests = false;
    for (const emptyManifest of emptyManifests) {
      emptyManifest.itemCount = 0;
      emptyManifest.payload = structuredClone(emptyPayload);
      await fs.writeFile(
        getShardManifestPath(path.join(folder, 'shards', String(emptyManifest.shardIndex))),
        JSON.stringify(emptyManifest)
      );
    }

    const result: ICliResult = await runCollatorAsync();
    expect(result.code).toBe(1);
    expect(result.output).toContain('No Jest tests were selected');
    expect(result.output).toContain('Jest collated 2 shards');
    await expect(readReportAsync()).resolves.toMatchObject({
      success: false,
      passWithNoTests: false,
      itemCount: 0,
      diagnosticCount: 1,
      testFiles: []
    });
  }, 180000);

  it('accepts selected suites whose assertions are all skipped', async () => {
    const skippedManifests: IShardResultManifest[] = structuredClone(baseline);
    const skippedManifest: IShardResultManifest = skippedManifests.find(
      (candidate) => candidate.itemCount > 0
    )!;
    const payload: IJestShardPayload = skippedManifest.payload as IJestShardPayload;
    payload.skipped = payload.testFiles[0].skipped = 1;
    payload.passed = payload.testFiles[0].passed = 0;
    skippedManifest.itemCount = 0;
    for (const candidate of skippedManifests) {
      await fs.writeFile(
        getShardManifestPath(path.join(folder, 'shards', String(candidate.shardIndex))),
        JSON.stringify(candidate)
      );
    }

    const result: ICliResult = await runCollatorAsync();
    expect(result.code).toBe(0);
    await expect(readReportAsync()).resolves.toMatchObject({
      success: true,
      itemCount: 0,
      diagnosticCount: 0,
      totals: { skipped: 1 }
    });
  }, 180000);

  it.each(['', '  '])(
    'requires a current generation (%j) before accepting any cached results',
    async (generation) => {
      const result = await runCollatorAsync(generation);
      expect(result.code).toBe(1);
      expect(result.output).toContain('RUSH_SHARD_GENERATION');
      await expectNoReportAsync();
    },
    180000
  );

  it.each(['--clean', 'watch'])(
    'rejects %s before prerequisite cleaning or report mutation',
    async (mode) => {
      const result = await runHeftCommandAsync(folder, [
        mode === 'watch' ? 'run-watch' : 'run',
        '--to',
        'test-collate',
        '--',
        ...COLLATE_ARGS,
        ...(mode === '--clean' ? ['--clean'] : [])
      ]);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        mode === 'watch' ? 'cannot be used with watch mode' : 'cannot be used with --clean'
      );
      expect(result.output).not.toContain('Waiting for changes');
      expect(await readReportAsync()).toEqual({ success: true, old: true });
      expect(await fs.readFile(path.join(folder, 'temp', 'keep.json'), 'utf8')).toBe('keep');
    },
    180000
  );

  it('requires collation arguments even with no separate neutral plugin configured', async () => {
    const result = await runHeftCommandAsync(folder, ['run', '--only', 'test-collate']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('requires both "--shard-parent-folder" and "--shard-count"');
    await expectNoReportAsync();
  }, 180000);

  it('surfaces output errors rather than returning a successful collator exit', async () => {
    await fs.unlink(path.join(folder, 'temp', 'jest-collated.json'));
    await fs.mkdir(path.join(folder, 'temp', 'jest-collated.json'));
    const result = await runCollatorAsync();
    expect(result.code).toBe(1);
    expect(result.output).not.toContain('Jest collated');
    expect((await fs.stat(path.join(folder, 'temp', 'jest-collated.json'))).isDirectory()).toBe(true);
  }, 180000);
});
