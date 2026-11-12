// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { HeftConfiguration, IHeftTaskSession } from '@rushstack/heft';
import type {
  IShardCollationAdapter,
  IShardCollationContext,
  IShardCollationSession
} from '@rushstack/heft/lib/sharding/IShardCollationAdapter';
import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';
import * as runner from '@rushstack/heft/lib/sharding/ShardCollationRunner';
import { ShardCollationTask } from '@rushstack/heft/lib/sharding/ShardCollationTask';
import { validateShardResults } from '@rushstack/heft/lib/sharding/ShardCollation';
import { writeShardResultManifestAsync } from '@rushstack/heft/lib/sharding/ShardResultManifest';
import { StringBufferTerminalProvider, Terminal } from '@rushstack/terminal';

import { JestCollationAdapter, type IJestCollatorOptions } from '../JestCollation';
import JestCollatorPlugin from '../JestCollatorPlugin';
import { disabledJestCoverage } from '../JestCoverage';
import { SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME } from '@rushstack/heft/lib/sharding/ShardOutputOwnership';

describe('Jest collation output ownership', () => {
  let folder: string;
  let manifest: IShardResultManifest;
  const sessions: IShardCollationSession[] = [];
  const signal = new AbortController().signal;
  const terminal = new Terminal(new StringBufferTerminalProvider(false));

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(__dirname, 'collation-ownership-'));
    const coverage = disabledJestCoverage();
    coverage.configuration.enabled = true;
    coverage.configuration.reporters = ['json'];
    coverage.map = Object.create(null);
    manifest = {
      version: 1,
      workload: 'jest',
      status: 'completed',
      shardIndex: 1,
      shardCount: 1,
      generation: 'generation-A',
      producerAttempt: 'attempt-A',
      startedAt: '2026-09-14T00:00:00.000Z',
      durationMs: 1,
      itemCount: 1,
      diagnosticCount: 0,
      payload: {
        version: 3,
        passWithNoTests: true,
        coverage,
        passed: 1,
        failed: 0,
        skipped: 0,
        todo: 0,
        failedSuites: 0,
        runtimeErrorSuites: 0,
        snapshotFailure: false,
        success: true,
        failureReasons: [],
        testFiles: [
          {
            path: 'test.js',
            passed: 1,
            failed: 0,
            skipped: 0,
            todo: 0,
            failureMessage: null,
            executionError: null,
            snapshotFailure: false,
            failures: [],
            assertions: [
              {
                title: 'passes',
                fullName: 'passes',
                ancestorTitles: [],
                status: 'passed',
                durationMs: 1,
                failureMessages: []
              }
            ]
          }
        ]
      }
    };
    await writeShardResultManifestAsync(path.join(folder, 'shards', '1'), manifest);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const session of sessions) session.release();
    sessions.length = 0;
    await fs.rm(folder, { recursive: true, force: true });
  });

  function context(abortSignal: AbortSignal = signal): Required<IShardCollationContext> {
    return {
      shardParentFolderPath: path.join(folder, 'shards'),
      shardCount: 1,
      expectedGeneration: manifest.generation,
      abortSignal
    };
  }
  function options(): runner.IShardCollationRunOptions {
    return { ...context(), buildFolderPath: folder };
  }
  function adapter(overrides?: IJestCollatorOptions, buildFolder: string = folder): JestCollationAdapter {
    return new JestCollationAdapter(buildFolder, terminal, overrides);
  }
  async function acquireAsync(overrides?: IJestCollatorOptions): Promise<IShardCollationSession> {
    const session = await adapter(overrides).acquireAsync(context());
    sessions.push(session);
    return session;
  }
  async function publishAsync(session: IShardCollationSession): Promise<void> {
    await session.prepareAsync();
    await session.collateAsync(validateShardResults([manifest], 1));
  }
  async function snapshotAsync(): Promise<string[]> {
    return await Promise.all(
      [
        'jest-collated.json',
        'jest-collated-coverage.files.json',
        path.join('jest-collated-coverage', 'coverage-final.json'),
        path.join('jest-collated-coverage', 'lcov.info')
      ].map((file) => fs.readFile(path.join(folder, 'temp', file), 'utf8'))
    );
  }

  it.each(['reports/results.xml', 'results.xml'])(
    'claims and publishes JUnit at %s independently of JSON',
    async (junitOutputFile) => {
      const session = await acquireAsync({ junitOutputFile });
      await publishAsync(session);
      const xmlPath = path.join(folder, junitOutputFile);
      const original = await fs.readFile(xmlPath, 'utf8');
      expect(original).toContain('name="passes"');
      await expect(
        adapter({
          reportFilename: 'different.json',
          junitOutputFile
        }).acquireAsync(context())
      ).rejects.toThrow(/already owned/);
      expect(await fs.readFile(xmlPath, 'utf8')).toBe(original);
    }
  );

  it.each(['shards/report.xml', 'temp/jest-collated-coverage/report.xml', '../outside.xml'])(
    'rejects unsafe JUnit destination %s before touching outputs',
    async (junitOutputFile) => {
      await expect(adapter({ junitOutputFile }).prepareAsync(context())).rejects.toThrow();
      expect(await fs.readFile(path.join(folder, 'shards', '1', 'shard-manifest.json'), 'utf8')).toContain(
        'generation-A'
      );
    }
  );

  it('rejects hard-linked JUnit files and junction aliases without modifying the target', async () => {
    const source = path.join(folder, 'source.xml');
    await fs.writeFile(source, 'preserve source');
    await fs.link(source, path.join(folder, 'results.xml'));
    await expect(adapter({ junitOutputFile: 'results.xml' }).prepareAsync(context())).rejects.toThrow(
      /hard link/
    );
    await fs.mkdir(path.join(folder, 'reports'));
    await fs.symlink(path.join(folder, 'reports'), path.join(folder, 'alias'), 'junction');
    await expect(adapter({ junitOutputFile: 'alias/results.xml' }).prepareAsync(context())).rejects.toThrow(
      /symbolic link/
    );
    expect(await fs.readFile(source, 'utf8')).toBe('preserve source');
  });

  it.each(['failure', 'cancellation'])(
    'invalidates JUnit and JSON while retaining ownership after publication %s',
    async (mode) => {
      const controller = new AbortController();
      const rename = fsSync.renameSync.bind(fsSync);
      jest.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
        if (mode === 'failure' && String(to).endsWith('jest-collated.json')) {
          throw new Error('publication failure');
        }
        rename(from, to);
        if (mode === 'cancellation' && String(to).endsWith('results.xml')) {
          controller.abort(new Error('publication cancellation'));
        }
      });
      await expect(
        runner.collateShardsAsync(
          options(),
          adapter({ junitOutputFile: 'reports/results.xml' }),
          controller.signal
        )
      ).rejects.toThrow(`publication ${mode}`);
      await expect(fs.readFile(path.join(folder, 'reports', 'results.xml'))).rejects.toThrow(/ENOENT/);
      await expect(fs.readFile(path.join(folder, 'temp', 'jest-collated.json'))).rejects.toThrow(/ENOENT/);
      jest.restoreAllMocks();
      await runner.collateShardsAsync(options(), adapter({ junitOutputFile: 'reports/results.xml' }), signal);
    }
  );

  it.each([
    { outputDirectory: 'temp' },
    { outputDirectory: path.join('temp', 'unused', '..') },
    { reportFilename: 'jest-collated-coverage.files.json' },
    { outputDirectory: path.join('temp', 'jest-collated-coverage'), reportFilename: 'nested.json' }
  ])('rejects overlapping options without touching reports or coverage: %j', async (overrides) => {
    const session = await acquireAsync();
    await publishAsync(session);
    const original = await snapshotAsync();
    await expect(runner.collateShardsAsync(options(), adapter(overrides), signal)).rejects.toThrow(
      /already owned/
    );
    expect(await snapshotAsync()).toEqual(original);
  });

  it('holds ownership before preparation and supports disjoint collators in the same output directory', async () => {
    const first = await acquireAsync();
    await expect(adapter().prepareAsync(context())).rejects.toThrow(/already owned/);
    const second = await acquireAsync({ reportFilename: 'other.json' });
    await Promise.all([publishAsync(first), publishAsync(second)]);
    expect(JSON.parse(await fs.readFile(path.join(folder, 'temp', 'other.json'), 'utf8')).success).toBe(true);
    expect(JSON.parse((await snapshotAsync())[0]).success).toBe(true);
  });

  it('never lets an old session clean or publish after release and a new generation takes ownership', async () => {
    const first = await adapter().acquireAsync(context());
    await publishAsync(first);
    first.release();
    manifest = { ...manifest, generation: 'generation-B' };
    await writeShardResultManifestAsync(path.join(folder, 'shards', '1'), manifest);
    const second = await acquireAsync();
    await publishAsync(second);
    const original = await snapshotAsync();
    await expect(first.prepareAsync()).rejects.toThrow(/released/);
    await expect(first.collateAsync(validateShardResults([manifest], 1))).rejects.toThrow(/released/);
    expect(() => first.release()).toThrow(/released/);
    expect(await snapshotAsync()).toEqual(original);
  });

  it('shares report ownership for different coverage folders under Windows filename case aliases', async () => {
    if (process.platform !== 'win32') return;
    await publishAsync(await acquireAsync());
    const original = await snapshotAsync();
    await expect(adapter({ reportFilename: 'JEST-COLLATED.json' }).acquireAsync(context())).rejects.toThrow(
      /already owned/
    );
    expect(await snapshotAsync()).toEqual(original);
  });

  it('shares ownership for a symlinked workspace root, but rejects output junctions', async () => {
    await publishAsync(await acquireAsync());
    const alias = path.join(folder, 'workspace-alias');
    await fs.symlink(folder, alias, 'junction');
    await expect(
      adapter(undefined, alias).acquireAsync({
        ...context(),
        shardParentFolderPath: path.join(alias, 'shards')
      })
    ).rejects.toThrow(/already owned/);
    const outputAlias = path.join(folder, 'output-alias');
    await fs.symlink(path.join(folder, 'temp'), outputAlias, 'junction');
    await expect(adapter({ outputDirectory: 'output-alias' }).acquireAsync(context())).rejects.toThrow(
      /symbolic link/
    );
  });

  (process.platform === 'win32' ? it : it.skip)(
    'canonicalizes materialized Windows short-path output aliases',
    async () => {
      const outputDirectory = 'long-output-directory';
      const session = await acquireAsync({ outputDirectory });
      await publishAsync(session);
      const shortName = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:HEFT_COLLATION_ALIAS).ShortName'
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, HEFT_COLLATION_ALIAS: path.join(folder, outputDirectory) }
        }
      ).trim();
      // A volume with 8.3 names disabled still exercises equivalent spelling; never invent an alias.
      await expect(adapter({ outputDirectory: shortName }).acquireAsync(context())).rejects.toThrow(
        /already owned/
      );
    }
  );

  it('releases claims after preparation and collation exceptions, without deleting uncertain coverage', async () => {
    await runner.collateShardsAsync(options(), adapter(), signal);
    const inventoryPath = path.join(folder, 'temp', 'jest-collated-coverage.files.json');
    const inventory = await fs.readFile(inventoryPath, 'utf8');
    await expect(
      runner.collateShardsAsync({ ...options(), shardCount: undefined }, adapter(), signal)
    ).rejects.toThrow(/Cannot verify coverage sources/);
    expect(await fs.readFile(inventoryPath, 'utf8')).toBe(inventory);
    await expect(fs.readFile(path.join(folder, 'temp', 'jest-collated.json'))).rejects.toThrow(/ENOENT/);
    await runner.collateShardsAsync(options(), adapter(), signal);
    const rename = fsSync.renameSync.bind(fsSync);
    jest.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('jest-collated.json')) throw new Error('publication failed');
      rename(from, to);
    });
    await expect(runner.collateShardsAsync(options(), adapter(), signal)).rejects.toThrow(
      'publication failed'
    );
    jest.restoreAllMocks();
    await runner.collateShardsAsync(options(), adapter(), signal);
  });

  it('holds real adapter ownership across the neutral return and outer task cancellation cleanup', async () => {
    const controller = new AbortController();
    let task!: (options: { abortSignal: AbortSignal }) => Promise<void>;
    const runtime = new ShardCollationTask();
    const config = {
      buildFolderPath: folder,
      tempFolderPath: path.join(folder, 'temp'),
      projectPackageJson: { name: 'ownership-test' }
    } as HeftConfiguration;
    const neutralSession = {
      parameters: {
        watch: false,
        clean: false,
        getStringParameter: () => ({ value: 'shards' }),
        getIntegerParameter: () => ({ value: 1 })
      },
      hooks: {
        run: {
          tapPromise: (name: string, callback: typeof task) => {
            task = callback;
          }
        }
      },
      logger: {
        emitError: (error: Error) => {
          throw error;
        },
        terminal
      }
    } as unknown as IHeftTaskSession;
    const adapterSession = {
      registerShardCollator: (workloadAdapter: IShardCollationAdapter) =>
        runtime.register(neutralSession, folder, workloadAdapter),
      taskName: 'jest',
      tempFolderPath: path.join(folder, 'temp', 'collate', 'jest'),
      logger: { terminal }
    } as unknown as IHeftTaskSession;
    new JestCollatorPlugin().apply(adapterSession, config);
    const originalRun = runner.collateShardsAsync;
    let oldSession!: IShardCollationSession;
    jest
      .spyOn(runner, 'collateShardsAsync')
      .mockImplementation(async (runOptions, workloadAdapter, abortSignal) => {
        const result = await originalRun(
          {
            ...runOptions,
            onSessionAcquired: (session) => {
              oldSession = session;
              runOptions.onSessionAcquired!(session);
            }
          },
          workloadAdapter,
          abortSignal
        );
        const original = await snapshotAsync();
        await expect(originalRun(options(), adapter(), signal)).rejects.toThrow(/already owned/);
        expect(await snapshotAsync()).toEqual(original);
        controller.abort(new Error('late outer cancellation'));
        return result;
      });
    const oldGeneration = process.env.RUSH_SHARD_GENERATION;
    process.env.RUSH_SHARD_GENERATION = manifest.generation;
    try {
      await expect(task({ abortSignal: controller.signal })).rejects.toThrow('late outer cancellation');
    } finally {
      if (oldGeneration === undefined) delete process.env.RUSH_SHARD_GENERATION;
      else process.env.RUSH_SHARD_GENERATION = oldGeneration;
      jest.restoreAllMocks();
    }
    await expect(fs.readFile(path.join(folder, 'temp', 'jest-collated.json'))).rejects.toThrow(/ENOENT/);
    await expect(fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage.files.json'))).rejects.toThrow(
      /ENOENT/
    );
    expect(
      await fs.readdir(path.join(folder, SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME), { withFileTypes: true })
    ).toHaveLength(0);
    manifest = { ...manifest, generation: 'generation-B' };
    await writeShardResultManifestAsync(path.join(folder, 'shards', '1'), manifest);
    await originalRun(options(), adapter(), signal);
    const replacement = await snapshotAsync();
    await expect(oldSession.prepareAsync()).rejects.toThrow(/released/);
    expect(await snapshotAsync()).toEqual(replacement);
    expect(JSON.parse(replacement[0]).generation).toBe('generation-B');
  });
});
