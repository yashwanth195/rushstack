// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '@jest/types';
import { defaults } from 'jest-config';
import { encodedMappings, TraceMap, type DecodedSourceMap } from '@jridgewell/trace-mapping';
import { createCoverageMap } from 'istanbul-lib-coverage';
import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';
import {
  readShardResultManifestAsync,
  getShardManifestPath,
  tryReadShardResultManifestAsync
} from '@rushstack/heft/lib/sharding/ShardResultManifest';
import { collateShardsAsync } from '@rushstack/heft/lib/sharding/ShardCollationRunner';
import { StringBufferTerminalProvider, Terminal } from '@rushstack/terminal';

import { JestCollationAdapter, type IJestCollatedReport } from '../JestCollation';
import { validateJestShardManifest, type IJestShardPayload } from '../JestShardPayload';
import {
  mergeJestCoverage,
  portableCoverageMap,
  readCoverageSourceAsync,
  validateJestCoverage,
  type ICoverageSource,
  type IJestFileCoverageData
} from '../JestCoverage';
import {
  configureCoverageCollatorAsync,
  createFixtureAsync,
  runHeftAsync,
  runHeftCommandAsync,
  writeConfigAsync
} from './JestShardTestHelpers';

const SOURCE: string = [
  'module.exports = function choose(value) {',
  '  if (value) {',
  "    return 'yes';",
  '  }',
  "  return 'no';",
  '};',
  ''
].join('\n');

async function writeSourcesAsync(folder: string, both: boolean = true): Promise<void> {
  await fs.writeFile(path.join(folder, 'source.js'), SOURCE);
  await fs.writeFile(
    path.join(folder, 'one.test.js'),
    "test('yes', () => expect(require('./source')(true)).toBe('yes'));"
  );
  if (both) {
    await fs.writeFile(
      path.join(folder, 'two.test.js'),
      "test('no', () => expect(require('./source')(false)).toBe('no'));"
    );
  }
}

async function runShardsAsync(
  folder: string,
  generation: string = 'generation-1'
): Promise<IShardResultManifest[]> {
  const manifests: IShardResultManifest[] = [];
  for (const index of [1, 2]) {
    const result = await runHeftAsync(
      folder,
      [`--shard=${index}/2`, `--shard-output-directory=shards/${index}`],
      generation
    );
    if (result.code !== 0) throw new Error(result.output);
    expect(result).toEqual({ code: 0, output: expect.stringContaining('verdict deferred') });
    manifests.push(await readShardResultManifestAsync(path.join(folder, 'shards', String(index))));
  }
  return manifests;
}

async function runCollatorAsync(
  folder: string,
  generation: string = 'generation-1'
): Promise<Awaited<ReturnType<typeof runHeftCommandAsync>>> {
  return await runHeftCommandAsync(
    folder,
    ['run', '--only', 'collate', '--', '--shard-parent-folder=shards', '--shard-count=2'],
    generation
  );
}

async function readReportAsync(folder: string): Promise<IJestCollatedReport> {
  return JSON.parse(await fs.readFile(path.join(folder, 'temp', 'jest-collated.json'), 'utf8'));
}

async function readCanonicalCoverageAsync(folder: string): Promise<Record<string, IJestFileCoverageData>> {
  const canonical = createCoverageMap(
    JSON.parse(
      await fs.readFile(path.join(folder, 'canonical', 'coverage-final.json'), 'utf8'),
      // Istanbul serializes its unmapped end-of-line Infinity sentinel as null.
      (key, value) => (key === 'column' && value === null ? Number.POSITIVE_INFINITY : value)
    )
  );
  const sources: Map<string, ICoverageSource> = new Map();
  for (const filename of canonical.files()) {
    const identity: string = path.relative(folder, filename).replaceAll('\\', '/');
    sources.set(identity, await readCoverageSourceAsync(folder, identity));
  }
  return portableCoverageMap(canonical, folder, sources);
}

describe.each(['v8', 'babel'] as const)('managed %s coverage (real workspace Heft)', (provider) => {
  let fixture: string;
  let folder: string;
  let baseline: IShardResultManifest[];

  beforeAll(async () => {
    fixture = await createFixtureAsync();
    await configureCoverageCollatorAsync(fixture);
    await writeSourcesAsync(fixture);
    await writeConfigAsync(fixture, {
      collectCoverage: true,
      coverageProvider: provider,
      collectCoverageFrom: ['source.js'],
      coverageThreshold: { global: { statements: 100, branches: 100, functions: 100, lines: 100 } },
      coverageReporters: ['json', 'lcov', 'clover', 'cobertura', 'json-summary', 'text-summary']
    });
    baseline = await runShardsAsync(fixture);
  }, 180000);

  afterAll(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
  });
  beforeEach(async () => {
    folder = await createFixtureAsync();
    await configureCoverageCollatorAsync(folder);
    await fs.writeFile(path.join(folder, 'source.js'), SOURCE);
    for (const manifest of baseline) {
      const output: string = path.join(folder, 'shards', String(manifest.shardIndex));
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(getShardManifestPath(output), JSON.stringify(manifest));
    }
  });
  afterEach(async () => {
    if (folder) await fs.rm(folder, { recursive: true, force: true });
  });

  async function collateDirectAsync(signal: AbortSignal = new AbortController().signal): Promise<number> {
    const verdict = await collateShardsAsync(
      {
        buildFolderPath: folder,
        shardParentFolderPath: path.join(folder, 'shards'),
        shardCount: 2,
        expectedGeneration: 'generation-1'
      },
      new JestCollationAdapter(folder, new Terminal(new StringBufferTerminalProvider(false))),
      signal
    );
    return verdict.diagnosticCount;
  }

  async function rewriteAsync(index: number, mutate: (payload: IJestShardPayload) => void): Promise<void> {
    const manifest: IShardResultManifest = structuredClone(baseline[index - 1]);
    mutate(manifest.payload as IJestShardPayload);
    await fs.writeFile(
      getShardManifestPath(path.join(folder, 'shards', String(index))),
      JSON.stringify(manifest)
    );
  }

  it('defers individually failing thresholds, sums hits and passes the complete portable union', async () => {
    for (const manifest of baseline) {
      const payload: IJestShardPayload = validateJestShardManifest(manifest);
      expect(createCoverageMap(payload.coverage.map!).getCoverageSummary().lines.pct).toBeLessThan(100);
      expect(manifest.diagnosticCount).toBe(0);
      expect(JSON.stringify(payload.coverage)).not.toContain(fixture.replaceAll('\\', '\\\\'));
    }
    const result = await runCollatorAsync(folder);
    expect(result).toEqual({ code: 0, output: expect.stringContaining('Jest collated 2 shards') });
    const report: IJestCollatedReport = await readReportAsync(folder);
    expect(report).toMatchObject({
      version: 2,
      success: true,
      diagnosticCount: 0,
      coverage: { messages: [] }
    });
    const merged = JSON.parse(
      await fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage', 'coverage-final.json'), 'utf8')
    );
    expect(Object.keys(merged)).toEqual(['source.js']);
    expect(merged['source.js'].path).toBe('source.js');
    expect(createCoverageMap(merged).getCoverageSummary().lines.pct).toBe(100);
    const first = createCoverageMap((baseline[0].payload as IJestShardPayload).coverage.map!);
    const second = createCoverageMap((baseline[1].payload as IJestShardPayload).coverage.map!);
    expect(merged['source.js'].s[0]).toBe(
      first.fileCoverageFor('source.js').s[0] + second.fileCoverageFor('source.js').s[0]
    );
    expect(
      await fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage', 'lcov.info'), 'utf8')
    ).toContain('SF:source.js');
    expect(report.coverage.files).toEqual(
      expect.arrayContaining([
        'temp/jest-collated-coverage/lcov-report/index.html',
        'temp/jest-collated-coverage/clover.xml',
        'temp/jest-collated-coverage/cobertura-coverage.xml',
        'temp/jest-collated-coverage/coverage-summary.json'
      ])
    );
    expect(await fs.readFile(path.join(folder, 'downstream', 'jest-collated.json'), 'utf8')).toContain(
      '"success":true'
    );
  }, 180000);

  it.each([
    'missing-map',
    'missing-file',
    'bad-counter',
    'overflow',
    'bad-branch',
    'bad-map',
    'disabled',
    'different-provider',
    'different-config',
    'different-source'
  ])('fails closed on %s without leaving a previous success', async (failure) => {
    await fs.mkdir(path.join(folder, 'temp'));
    await fs.writeFile(path.join(folder, 'temp', 'jest-collated.json'), '{"success":true}');
    await rewriteAsync(1, (payload) => {
      const coverage = payload.coverage;
      const file = coverage.map!['source.js'];
      switch (failure) {
        case 'missing-map':
          coverage.map = null;
          break;
        case 'missing-file':
          coverage.map = {};
          break;
        case 'bad-counter':
          file.s[0] = -1;
          break;
        case 'overflow':
          file.s[0] = Number.MAX_SAFE_INTEGER + 1;
          break;
        case 'bad-branch':
          file.b[0].push(1);
          break;
        case 'bad-map':
          file.statementMap[0].end.column++;
          break;
        case 'disabled':
          coverage.configuration.enabled = false;
          coverage.configuration.thresholds = null;
          coverage.map = null;
          coverage.sourceHashes = {};
          coverage.expectedFiles = [];
          break;
        case 'different-provider':
          coverage.configuration.provider = provider === 'v8' ? 'babel' : 'v8';
          break;
        case 'different-config':
          coverage.configuration.collectCoverageFrom.push('other.js');
          break;
        case 'different-source':
          coverage.sourceHashes['source.js'] = 'a'.repeat(64);
          break;
      }
    });
    await expect(collateDirectAsync()).rejects.toThrow();
    await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
  });

  it('rejects a corrupt cached coverage commit', async () => {
    await fs.writeFile(getShardManifestPath(path.join(folder, 'shards', '1')), '{"payload":{"coverage":');
    await expect(collateDirectAsync()).rejects.toThrow();
    await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
  });

  it('uses Jest path/glob thresholds, subtracts matched files from global and fails missing matches', async () => {
    for (const index of [1, 2]) {
      await rewriteAsync(index, (payload) => {
        payload.coverage.configuration.thresholds = {
          global: { lines: 101 },
          './': { lines: 100 },
          './source.js': { lines: 100 }
        };
      });
    }
    expect(await collateDirectAsync()).toBe(0);
    for (const index of [1, 2]) {
      await rewriteAsync(index, (payload) => {
        payload.coverage.configuration.thresholds = {
          global: {},
          './*.js': { lines: 101 },
          './missing.js': { lines: 0 }
        };
      });
    }
    expect(await collateDirectAsync()).toBe(2);
    expect((await readReportAsync(folder)).coverage.messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('coverage threshold for lines (101%)'),
        expect.stringContaining('Coverage data for missing.js was not found')
      ])
    );
  });

  it('does not publish success if a builtin report cannot be written', async () => {
    await fs.mkdir(path.join(folder, 'temp', 'jest-collated-coverage', 'lcov.info'), { recursive: true });
    await expect(collateDirectAsync()).rejects.toThrow(/regular file/);
    await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
  });

  it('preserves an unowned coverage target across failed and repeated attempts', async () => {
    const output: string = path.join(folder, 'temp', 'jest-collated-coverage');
    await fs.mkdir(output, { recursive: true });
    const target: string = path.join(output, 'coverage-final.json');
    await fs.writeFile(target, 'user data');
    for (let attempt: number = 0; attempt < 2; attempt++) {
      await expect(collateDirectAsync()).rejects.toThrow(/unowned.*manually/i);
      expect(await fs.readFile(target, 'utf8')).toBe('user data');
      expect(await fs.readFile(path.join(folder, 'source.js'), 'utf8')).toBe(SOURCE);
      await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
    }
  });

  it('replaces unchanged owned reports but preserves a user-modified owned file', async () => {
    expect(await collateDirectAsync()).toBe(0);
    expect(await collateDirectAsync()).toBe(0);
    const target: string = path.join(folder, 'temp', 'jest-collated-coverage', 'lcov.info');
    const inventory: string = path.join(folder, 'temp', 'jest-collated-coverage.files.json');
    const originalInventory: string = await fs.readFile(inventory, 'utf8');
    await fs.writeFile(target, 'user edits');
    for (let attempt: number = 0; attempt < 2; attempt++) {
      await expect(collateDirectAsync()).rejects.toThrow(/modified.*manually/i);
      expect(await fs.readFile(target, 'utf8')).toBe('user edits');
      expect(await fs.readFile(inventory, 'utf8')).toBe(originalInventory);
      expect(await fs.readFile(path.join(folder, 'source.js'), 'utf8')).toBe(SOURCE);
    }
  });

  it.each([
    { shardCount: undefined },
    { shardCount: 0 },
    { expectedGeneration: undefined },
    { expectedGeneration: ' ' }
  ])('preserves previous coverage when the requested identity is invalid: %j', async (overrides) => {
    expect(await collateDirectAsync()).toBe(0);
    const target: string = path.join(folder, 'temp', 'jest-collated-coverage', 'lcov.info');
    const inventoryPath: string = path.join(folder, 'temp', 'jest-collated-coverage.files.json');
    const original: string = await fs.readFile(target, 'utf8');
    const inventory: string = await fs.readFile(inventoryPath, 'utf8');
    await expect(
      collateShardsAsync(
        {
          buildFolderPath: folder,
          shardParentFolderPath: path.join(folder, 'shards'),
          shardCount: 2,
          expectedGeneration: 'generation-1',
          ...overrides
        },
        new JestCollationAdapter(folder, new Terminal(new StringBufferTerminalProvider(false))),
        new AbortController().signal
      )
    ).rejects.toThrow(/Cannot verify coverage sources/);
    expect(await fs.readFile(target, 'utf8')).toBe(original);
    expect(await fs.readFile(inventoryPath, 'utf8')).toBe(inventory);
    await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
  });

  it('does not trust an old path-only coverage inventory', async () => {
    const output: string = path.join(folder, 'temp', 'jest-collated-coverage');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'lcov.info'), 'user data');
    await fs.writeFile(`${output}.files.json`, JSON.stringify(['lcov.info']));
    await expect(collateDirectAsync()).rejects.toThrow(/inventory.*manually/i);
    expect(await fs.readFile(path.join(output, 'lcov.info'), 'utf8')).toBe('user data');
  });

  it('verifies current sources before cleaning any prior coverage reports', async () => {
    expect(await collateDirectAsync()).toBe(0);
    const target: string = path.join(folder, 'temp', 'jest-collated-coverage', 'lcov.info');
    const report: string = await fs.readFile(target, 'utf8');
    const changed: string = `${SOURCE}// changed after collection\n`;
    await fs.writeFile(path.join(folder, 'source.js'), changed);
    for (let attempt: number = 0; attempt < 2; attempt++) {
      await expect(collateDirectAsync()).rejects.toThrow(/source changed.*manually/i);
      expect(await fs.readFile(target, 'utf8')).toBe(report);
      expect(await fs.readFile(path.join(folder, 'source.js'), 'utf8')).toBe(changed);
      await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
    }
  });

  it('cleans partial report publication if the filesystem rejects a later rename', async () => {
    const rename: typeof fs.rename = fs.rename.bind(fs);
    const spy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('lcov.info')) throw new Error('report publication denied');
      await rename(from, to);
    });
    try {
      await expect(collateDirectAsync()).rejects.toThrow('report publication denied');
      await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
      await expect(
        fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage', 'coverage-final.json'))
      ).rejects.toThrow(/ENOENT/);
      await expect(
        fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage.files.json'))
      ).rejects.toThrow(/ENOENT/);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects attempts to write coverage through hard links or input aliases', async () => {
    const output: string = path.join(folder, 'temp', 'jest-collated-coverage');
    await fs.mkdir(output, { recursive: true });
    await fs.link(path.join(folder, 'source.js'), path.join(output, 'lcov.info'));
    await expect(collateDirectAsync()).rejects.toThrow(/hard link/);
    expect(await fs.readFile(path.join(folder, 'source.js'), 'utf8')).toBe(SOURCE);
    await fs.unlink(path.join(output, 'lcov.info'));
    await fs.rmdir(output);
    await fs.symlink(path.join(folder, 'shards'), output, 'junction');
    await expect(collateDirectAsync()).rejects.toThrow(/symbolic link/);
    expect(await readShardResultManifestAsync(path.join(folder, 'shards', '1'))).toEqual(baseline[0]);
  });

  it('invalidates precisely its prior reports on cancellation and preserves unrelated files', async () => {
    expect(await collateDirectAsync()).toBe(0);
    await fs.writeFile(path.join(folder, 'temp', 'jest-collated-coverage', 'keep.txt'), 'keep');
    const controller: AbortController = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(collateDirectAsync(controller.signal)).rejects.toThrow('cancelled');
    await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
    await expect(
      fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage', 'lcov.info'))
    ).rejects.toThrow(/ENOENT/);
    expect(await fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage', 'keep.txt'), 'utf8')).toBe(
      'keep'
    );
  });

  it('includes zero-hit collectCoverageFrom files and an empty sibling, and fails merged negative thresholds', async () => {
    await writeSourcesAsync(folder, false);
    await fs.writeFile(
      path.join(folder, 'untested.js'),
      'module.exports = function untested() { return 42; };\n'
    );
    await writeConfigAsync(folder, {
      collectCoverage: true,
      coverageProvider: provider,
      collectCoverageFrom: ['source.js', 'untested.js'],
      coverageThreshold: { global: { lines: 100, statements: -1 } },
      coverageReporters: ['json', 'lcovonly']
    });
    const manifests: IShardResultManifest[] = await runShardsAsync(folder);
    expect(manifests.map((manifest) => manifest.itemCount).sort()).toEqual([0, 1]);
    const coverage = await mergeJestCoverage(
      manifests.map((manifest) => validateJestShardManifest(manifest).coverage)
    );
    expect(Object.keys(coverage.map!).sort()).toEqual(['source.js', 'untested.js']);
    expect(createCoverageMap(coverage.map!).fileCoverageFor('untested.js').toSummary().lines.covered).toBe(0);
    const result = await runCollatorAsync(folder);
    expect(result.code).toBe(1);
    const report: IJestCollatedReport = await readReportAsync(folder);
    expect(report.success).toBe(false);
    expect(report.diagnosticCount).toBe(2);
    expect(report.coverage.messages.join('\n')).toContain('Uncovered count for statements');
    expect(report.coverage.messages.join('\n')).toContain('coverage threshold for lines');
    await expect(fs.readFile(path.join(folder, 'downstream', 'jest-collated.json'))).rejects.toThrow(
      /ENOENT/
    );
  }, 180000);
});

describe('coverage execution guards and regressions', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await createFixtureAsync();
  });
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });
  const managed: string[] = ['--shard=1/1', '--shard-output-directory=shards/1'];

  it.each([false, true])(
    'matches canonical V8 empty collection with unrelated CSS referencing a missing map (default transform=%s)',
    async (defaultTransform) => {
      await writeSourcesAsync(folder, false);
      await fs.writeFile(path.join(folder, 'site.css'), '/*# sourceMappingURL=site.css.map */\n');
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'v8',
        collectCoverageFrom: [],
        transform: defaultTransform ? undefined : {},
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalRun = await runHeftAsync(folder, []);
      if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
      const canonical = await readCanonicalCoverageAsync(folder);
      expect(Object.keys(canonical)).toEqual(['source.js']);
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const { coverage } = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(coverage.map).toEqual(canonical);
      expect(coverage.expectedFiles).toEqual(['source.js']);
      expect(coverage.sourceHashes).toEqual({
        'source.js': (await readCoverageSourceAsync(folder, 'source.js')).hash
      });
      expect(coverage.v8).toHaveLength(1);
    },
    180000
  );

  it.each([
    ['v8', false],
    ['v8', true],
    ['babel', false],
    ['babel', true]
  ] as const)(
    'matches canonical outside-root custom sources selected by extension or transform (%s, transform=%s)',
    async (provider, transformed) => {
      await fs.mkdir(path.join(folder, 'tests'));
      await fs.writeFile(
        path.join(folder, 'source.custom'),
        // Exercise changed V8 output without changing Babel's instrumentation input/provenance contract.
        transformed && provider === 'v8' ? SOURCE.replace('module.exports', 'module.customExports') : SOURCE
      );
      await fs.writeFile(
        path.join(folder, 'transformer.js'),
        `module.exports = { process(code, filename) {
          return { code: code.replace('module.customExports', 'module.exports'), map: {
            version: 3, sources: [filename], sourcesContent: [code], names: [],
            mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA'
          } };
        } };`
      );
      await fs.writeFile(
        path.join(folder, 'tests', 'one.test.js'),
        "test('custom source', () => expect(require('../source.custom')(true)).toBe('yes'));"
      );
      await writeConfigAsync(folder, {
        roots: ['<rootDir>/tests'],
        testMatch: ['<rootDir>/tests/*.test.js'],
        moduleFileExtensions: transformed ? undefined : [...defaults.moduleFileExtensions, 'custom'],
        transform: transformed ? { '\\.custom$': '<rootDir>/transformer.js' } : {},
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: provider === 'babel' ? ['source.custom'] : [],
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalRun = await runHeftAsync(folder, []);
      if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
      const canonical = await readCanonicalCoverageAsync(folder);
      expect(Object.keys(canonical)).toEqual(['source.custom']);
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const { coverage } = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(coverage.map).toEqual(canonical);
      expect(coverage.expectedFiles).toEqual(['source.custom']);
      expect(coverage.sourceHashes).toEqual({
        'source.custom': (await readCoverageSourceAsync(folder, 'source.custom')).hash
      });
      if (provider === 'v8') expect(coverage.v8).toHaveLength(1);
    },
    180000
  );

  it.each([
    ['babel', true],
    ['v8', true],
    ['v8', false]
  ] as const)(
    'matches canonical coverage for static inputs outside Jest roots (%s, collectCoverageFrom=%s)',
    async (provider, explicitCoverageFrom) => {
      await fs.mkdir(path.join(folder, 'tests'));
      await fs.writeFile(path.join(folder, 'source.js'), SOURCE);
      await fs.writeFile(path.join(folder, 'untouched.js'), SOURCE);
      await fs.writeFile(path.join(folder, 'ignored.js'), 'module.exports = 42;\n');
      await fs.writeFile(
        path.join(folder, 'tests', 'one.test.js'),
        "test('outside roots', () => { expect(require('../source')(true)).toBe('yes'); require('../ignored'); });"
      );
      await writeConfigAsync(folder, {
        roots: ['<rootDir>/tests'],
        testMatch: ['<rootDir>/tests/*.test.js'],
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: explicitCoverageFrom ? ['source.js', 'untouched.js'] : undefined,
        coveragePathIgnorePatterns: ['/node_modules/', 'ignored\\.js$'],
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalRun = await runHeftAsync(folder, []);
      if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
      const canonical = await readCanonicalCoverageAsync(folder);
      expect(Object.keys(canonical)).toEqual(['source.js']);
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const { coverage } = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(coverage.map).toEqual(canonical);
      expect(coverage.expectedFiles).toEqual(['source.js']);
      expect(coverage.sourceHashes).toEqual({
        'source.js': (await readCoverageSourceAsync(folder, 'source.js')).hash
      });
      if (provider === 'v8') expect(coverage.v8).toHaveLength(1);
    },
    180000
  );

  it.each([
    ['babel', false],
    ['v8', false],
    ['babel', true],
    ['v8', true]
  ] as const)(
    'rejects late or mutated inputs outside Jest roots (%s, existed=%s)',
    async (provider, existed) => {
      await fs.mkdir(path.join(folder, 'tests'));
      if (existed) await fs.writeFile(path.join(folder, 'source.js'), SOURCE);
      await fs.writeFile(
        path.join(folder, 'tests', 'one.test.js'),
        `test('changes source outside roots', () => {
          const filename = require('path').resolve(__dirname, '../source.js');
          require('fs').writeFileSync(filename, 'module.exports = () => 42;');
          expect(require(filename)()).toBe(42);
        });`
      );
      await writeConfigAsync(folder, {
        roots: ['<rootDir>/tests'],
        testMatch: ['<rootDir>/tests/*.test.js'],
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js']
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(
        existed
          ? /differs from its snapshot|does not match disk|verifiable inputSourceMap/
          : /Missing pre-execution Jest coverage input/
      );
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it('rejects outside-root loaded Babel code without counters or a runtime source map', async () => {
    await fs.mkdir(path.join(folder, 'tests'));
    await fs.writeFile(path.join(folder, 'source.js'), SOURCE);
    await fs.writeFile(
      path.join(folder, 'transformer.js'),
      'module.exports = { canInstrument: true, process(code) { return { code }; } };'
    );
    await fs.writeFile(
      path.join(folder, 'tests', 'one.test.js'),
      "test('outside roots', () => expect(require('../source')(true)).toBe('yes'));"
    );
    await writeConfigAsync(folder, {
      roots: ['<rootDir>/tests'],
      testMatch: ['<rootDir>/tests/*.test.js'],
      collectCoverage: true,
      coverageProvider: 'babel',
      collectCoverageFrom: ['source.js'],
      transform: { 'source\\.js$': '<rootDir>/transformer.js' },
      coverageDirectory: '<rootDir>/canonical',
      coverageReporters: ['json']
    });
    const canonicalRun = await runHeftAsync(folder, []);
    if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
    expect(await readCanonicalCoverageAsync(folder)).toEqual({});
    const result = await runHeftAsync(folder, managed);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Missing coverage map');
    await expect(tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))).resolves.toBeUndefined();
  }, 180000);

  it('requires outside-root Babel counters when runtime map evidence proves instrumentation', async () => {
    await fs.mkdir(path.join(folder, 'tests'));
    await fs.writeFile(path.join(folder, 'source.js'), SOURCE);
    await fs.writeFile(
      path.join(folder, 'tests', 'one.test.js'),
      `test('drops outside-root counters', () => {
        expect(require('../source')(true)).toBe('yes');
        delete global.__coverage__[require.resolve('../source')];
      });`
    );
    await writeConfigAsync(folder, {
      roots: ['<rootDir>/tests'],
      testMatch: ['<rootDir>/tests/*.test.js'],
      collectCoverage: true,
      coverageProvider: 'babel',
      collectCoverageFrom: ['source.js'],
      coverageDirectory: '<rootDir>/canonical',
      coverageReporters: ['json']
    });
    const canonicalRun = await runHeftAsync(folder, []);
    if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
    expect(await readCanonicalCoverageAsync(folder)).toEqual({});
    const result = await runHeftAsync(folder, managed);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Missing coverage map for required source "source.js"');
    await expect(tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))).resolves.toBeUndefined();
  }, 180000);

  it.each(['untouched', 'loaded', 'mutated-after-load', 'mutated-restored'] as const)(
    'validates outside-root ignored Babel input without runtime maps or transform caching (%s)',
    async (mode) => {
      await fs.mkdir(path.join(folder, 'tests'));
      const filename: string = path.join(folder, 'source.js');
      const input: string = '/* istanbul ignore file */\nmodule.exports = () => 1;\n';
      const changed: string = '/* istanbul ignore file */\nmodule.exports = () => 2;\n';
      await fs.writeFile(filename, input);
      await fs.writeFile(
        path.join(folder, 'transformer.js'),
        'module.exports = { canInstrument: true, process(code) { return { code }; } };'
      );
      await fs.writeFile(
        path.join(folder, 'tests', 'one.test.js'),
        `test('ignored without runtime evidence', () => {
          const fs = require('fs');
          const filename = require('path').resolve(__dirname, '../source.js');
          const saved = fs.readFileSync(filename, 'utf8');
          ${
            mode === 'mutated-restored'
              ? `fs.writeFileSync(filename, ${JSON.stringify(changed)});
                 expect(require(filename)()).toBe(2);
                 fs.writeFileSync(filename, saved);`
              : `${mode === 'untouched' ? '' : 'expect(require(filename)()).toBe(1);'}
                 ${mode === 'mutated-after-load' ? `fs.writeFileSync(filename, ${JSON.stringify(changed)});` : ''}`
          }
        });`
      );
      await writeConfigAsync(folder, {
        roots: ['<rootDir>/tests'],
        testMatch: ['<rootDir>/tests/*.test.js'],
        cache: false,
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js'],
        transform: { 'source\\.js$': '<rootDir>/transformer.js' },
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalRun = await runHeftAsync(folder, []);
      if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
      expect(await readCanonicalCoverageAsync(folder)).toEqual({});
      await fs.writeFile(filename, input);
      const result = await runHeftAsync(folder, managed);
      if (mode === 'mutated-restored') expect(await fs.readFile(filename, 'utf8')).toBe(input);
      if (mode === 'mutated-after-load' || mode === 'mutated-restored') {
        expect(result.code).not.toBe(0);
        expect(result.output).toMatch(/differs from its snapshot|does not match disk/);
        await expect(
          tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
        ).resolves.toBeUndefined();
      } else {
        if (result.code !== 0) throw new Error(result.output);
        const { coverage } = validateJestShardManifest(
          await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
        );
        expect(coverage).toMatchObject({ map: {}, sourceHashes: {}, expectedFiles: [] });
      }
    },
    180000
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ] as const)(
    'retains canonical empty outside-root Babel coverage (ignored loaded=%s, default transform=%s)',
    async (loaded, defaultTransform) => {
      await fs.mkdir(path.join(folder, 'tests'));
      await fs.writeFile(path.join(folder, 'source.js'), `/* istanbul ignore file */\n${SOURCE}`);
      await fs.writeFile(path.join(folder, 'untouched.js'), SOURCE);
      await fs.writeFile(
        path.join(folder, 'tests', 'one.test.js'),
        loaded
          ? "test('ignored outside roots', () => expect(require('../source')(true)).toBe('yes'));"
          : "test('untouched outside roots', () => {});"
      );
      await writeConfigAsync(folder, {
        roots: ['<rootDir>/tests'],
        testMatch: ['<rootDir>/tests/*.test.js'],
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js', 'untouched.js'],
        transform: defaultTransform ? undefined : {},
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalRun = await runHeftAsync(folder, []);
      if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
      const canonical = await readCanonicalCoverageAsync(folder);
      expect(canonical).toEqual({});
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const { coverage } = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(coverage).toMatchObject({ map: canonical, sourceHashes: {}, expectedFiles: [] });
    },
    180000
  );

  it('attests restored ignored input on a warm canonical transform cache without reprocessing it', async () => {
    await fs.mkdir(path.join(folder, 'tests'));
    const filename: string = path.join(folder, 'source.js');
    const original: string = '/* istanbul ignore file */\nmodule.exports = () => 1;\n';
    const changed: string = '/* istanbul ignore file */\nmodule.exports = () => 2;\n';
    await fs.writeFile(filename, original);
    await fs.writeFile(
      path.join(folder, 'transformer.js'),
      `const fs = require('fs');
      module.exports = { canInstrument: true,
        getCacheKey(code, filename, options) {
          fs.appendFileSync(__dirname + '/keys.log', JSON.stringify(code) + '\\n');
          return require('crypto').createHash('sha256').update(code).update(options.configString).digest('hex');
        },
        process(code) {
          fs.appendFileSync(__dirname + '/process.log', JSON.stringify(code) + '\\n');
          return { code };
        }
      };`
    );
    await fs.writeFile(
      path.join(folder, 'tests', 'one.test.js'),
      `test('loads ignored input', () => {
        const fs = require('fs');
        const filename = require('path').resolve(__dirname, '../source.js');
        const saved = fs.readFileSync(filename, 'utf8');
        const mutate = fs.existsSync(require('path').resolve(__dirname, '../mutate.flag'));
        if (mutate) fs.writeFileSync(filename, ${JSON.stringify(changed)});
        expect(require(filename)()).toBe(mutate ? 2 : saved.includes('=> 2') ? 2 : 1);
        if (mutate) fs.writeFileSync(filename, saved);
      });`
    );
    await writeConfigAsync(folder, {
      roots: ['<rootDir>/tests'],
      testMatch: ['<rootDir>/tests/*.test.js'],
      collectCoverage: true,
      coverageProvider: 'babel',
      collectCoverageFrom: ['source.js'],
      transform: { 'source\\.js$': '<rootDir>/transformer.js' },
      coverageDirectory: '<rootDir>/canonical',
      coverageReporters: ['json']
    });
    const canonical = await runHeftAsync(folder, []);
    if (canonical.code !== 0) throw new Error(canonical.output);
    expect(await readCanonicalCoverageAsync(folder)).toEqual({});
    await fs.writeFile(path.join(folder, 'process.log'), '');
    await fs.writeFile(filename, changed);
    const warm = await runHeftAsync(folder, managed);
    if (warm.code !== 0) throw new Error(warm.output);
    expect(
      validateJestShardManifest(await readShardResultManifestAsync(path.join(folder, 'shards', '1'))).coverage
    ).toMatchObject({ map: {}, expectedFiles: [], sourceHashes: {} });
    const processed: string = await fs.readFile(path.join(folder, 'process.log'), 'utf8');
    expect(processed).toBe(`${JSON.stringify(changed)}\n`);
    await fs.writeFile(path.join(folder, 'keys.log'), '');
    await fs.writeFile(filename, original);
    await fs.writeFile(path.join(folder, 'mutate.flag'), '');
    const result = await runHeftAsync(folder, managed);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('differs from its snapshot');
    expect(await fs.readFile(filename, 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(folder, 'keys.log'), 'utf8')).toContain(JSON.stringify(changed));
    expect(await fs.readFile(path.join(folder, 'process.log'), 'utf8')).toBe(processed);
    await expect(tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))).resolves.toBeUndefined();
    // Locate the shard cache using the same public identity helper as the plugin.
    const { getShardTempFolderPath, parseShardPair } =
      await import('@rushstack/heft/lib/sharding/ShardIdentity');
    const cache: string = getShardTempFolderPath(
      path.join(folder, 'temp', 'test', 'jest'),
      parseShardPair('1/1')
    );
    expect(await fs.readdir(path.join(cache, 'execution-inputs'), { withFileTypes: true })).toEqual([]);
  }, 180000);

  it.each(['none', 'default', 'ignored', 'sync', 'async'] as const)(
    'preserves canonical ignored input and observes restored mutations through the %s transform path',
    async (mode) => {
      const previousNodeOptions: string | undefined = process.env.NODE_OPTIONS;
      if (mode === 'async')
        process.env.NODE_OPTIONS = `${previousNodeOptions ?? ''} --experimental-vm-modules`;
      try {
        await fs.mkdir(path.join(folder, 'tests'));
        const extension: string = mode === 'async' ? 'mjs' : 'js';
        const filename: string = path.join(folder, `source.${extension}`);
        const original: string = `/* istanbul ignore file */\n${
          mode === 'async' ? 'export default' : 'module.exports ='
        } () => 1;\n`;
        const changed: string = original.replace('=> 1', '=> 2');
        await fs.writeFile(filename, original);
        await fs.writeFile(path.join(folder, 'untouched.js'), SOURCE);
        await fs.writeFile(
          path.join(folder, 'transformer.cjs'),
          mode === 'ignored'
            ? 'module.exports = { process() { throw new Error("Ignored transform was invoked"); } };'
            : `module.exports = { async createTransformer(settings) {
                if (settings.marker !== 'original') throw new Error('Lost transformer configuration');
                return { canInstrument: true,
                  ${mode === 'async' ? 'async getCacheKeyAsync' : 'getCacheKey'}(code, filename, options) {
                    if (options.config.globals.marker !== 'original' ||
                        options.transformerConfig.marker !== 'original' ||
                        !options.config.transform[0][1].endsWith('transformer.cjs') ||
                        !options.configString.includes('original')) throw new Error('Lost original options');
                    return require('crypto').createHash('sha256').update(code).update(options.configString).digest('hex');
                  },
                  ${mode === 'async' ? 'async processAsync' : 'process'}(code, filename, options) {
                    if (${mode === 'async'} !== options.supportsStaticESM) throw new Error('Changed caller capabilities');
                    if (options.cacheFS.get(filename) !== code) throw new Error('Lost runtime cacheFS');
                    if (options.cacheFS.set(filename, code) !== options.cacheFS ||
                        options.cacheFS.constructor !== Map ||
                        options.cacheFS.get !== options.cacheFS.get) throw new Error('Changed cacheFS methods');
                    options.cacheFS.forEach((value, key, cache) => {
                      if (cache !== options.cacheFS || cache.get(key) !== value) throw new Error('Changed cacheFS iteration');
                    });
                    return { code };
                  }
                };
              } };`
        );
        await fs.writeFile(
          path.join(folder, 'tests', 'one.test.js'),
          `test('ignored input boundary', async () => {
            const fs = require('fs');
            const filename = require('path').resolve(__dirname, '../source.${extension}');
            const saved = fs.readFileSync(filename, 'utf8');
            const mutate = fs.existsSync(require('path').resolve(__dirname, '../mutate.flag'));
            if (mutate) fs.writeFileSync(filename, ${JSON.stringify(changed)});
            const value = ${mode === 'async' ? '(await import(filename)).default' : 'require(filename)'};
            expect(value()).toBe(mutate ? 2 : 1);
            if (mutate) fs.writeFileSync(filename, saved);
          });`
        );
        await writeConfigAsync(folder, {
          roots: ['<rootDir>/tests'],
          testMatch: ['<rootDir>/tests/*.test.js'],
          globals: { marker: 'original' },
          collectCoverage: true,
          coverageProvider: 'babel',
          collectCoverageFrom: [`source.${extension}`, 'untouched.js'],
          transform:
            mode === 'default'
              ? undefined
              : mode === 'none'
                ? {}
                : {
                    [`source\\.${extension}$`]: ['<rootDir>/transformer.cjs', { marker: 'original' }]
                  },
          transformIgnorePatterns: mode === 'ignored' ? ['source\\.js$'] : undefined,
          coverageDirectory: '<rootDir>/canonical',
          coverageReporters: ['json']
        });
        const canonical = await runHeftAsync(folder, []);
        if (canonical.code !== 0) throw new Error(canonical.output);
        expect(await readCanonicalCoverageAsync(folder)).toEqual({});
        const unchanged = await runHeftAsync(folder, managed);
        if (unchanged.code !== 0) throw new Error(unchanged.output);
        expect(
          validateJestShardManifest(await readShardResultManifestAsync(path.join(folder, 'shards', '1')))
            .coverage
        ).toMatchObject({ map: {}, expectedFiles: [], sourceHashes: {} });
        await fs.writeFile(path.join(folder, 'mutate.flag'), '');
        const result = await runHeftAsync(folder, managed);
        expect(result.code).not.toBe(0);
        expect(result.output).toMatch(/differs from its snapshot|does not match disk/);
        expect(await fs.readFile(filename, 'utf8')).toBe(original);
        await expect(
          tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
        ).resolves.toBeUndefined();
      } finally {
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
    },
    180000
  );

  it.each([
    ['changed-after-load', false],
    ['changed-after-load', true],
    ['changed-before-load-restored', false],
    ['changed-before-load-restored', true],
    ['stale-original', false],
    ['stale-original', true],
    ['missing-original-content', false],
    ['missing-original-content', true]
  ] as const)(
    'rejects unverifiable outside-root ignored Babel evidence (%s, default transform=%s)',
    async (failure, defaultTransform) => {
      await fs.mkdir(path.join(folder, 'tests'));
      const ignored: string = `/* istanbul ignore file */\n${SOURCE}`;
      const changed: string = '/* istanbul ignore file */\nmodule.exports = () => "changed";\n';
      const filename: string = path.join(folder, 'source.js');
      const mapped: boolean = failure === 'stale-original' || failure === 'missing-original-content';
      await fs.writeFile(path.join(folder, 'original.js'), `${ignored}// current original\n`);
      const input: string = mapped ? `${ignored}//# sourceMappingURL=source.js.map\n` : ignored;
      if (mapped) {
        await fs.writeFile(
          path.join(folder, 'source.js.map'),
          JSON.stringify({
            version: 3,
            sources: ['original.js'],
            sourcesContent: failure === 'missing-original-content' ? undefined : [ignored],
            names: [],
            mappings: 'AAAA'
          })
        );
      }
      await fs.writeFile(filename, input);
      await fs.writeFile(
        path.join(folder, 'tests', 'one.test.js'),
        `test('ignored outside roots', () => {
          const fs = require('fs');
          const filename = require('path').resolve(__dirname, '../source.js');
          const saved = fs.readFileSync(filename, 'utf8');
          ${
            failure === 'changed-before-load-restored'
              ? `fs.writeFileSync(filename, ${JSON.stringify(changed)});
                 expect(require(filename)()).toBe('changed');
                 fs.writeFileSync(filename, saved);`
              : `expect(require(filename)(true)).toBe('yes');
                 ${failure === 'changed-after-load' ? `fs.writeFileSync(filename, ${JSON.stringify(changed)});` : ''}`
          }
        });`
      );
      await writeConfigAsync(folder, {
        roots: ['<rootDir>/tests'],
        testMatch: ['<rootDir>/tests/*.test.js'],
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js'],
        transform: defaultTransform ? undefined : {},
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalRun = await runHeftAsync(folder, []);
      if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
      expect(await readCanonicalCoverageAsync(folder)).toEqual({});
      await fs.writeFile(filename, input);
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(
        /differs from its snapshot|does not match disk|Missing trustworthy sourcesContent/
      );
      if (failure === 'changed-before-load-restored') {
        expect(await fs.readFile(filename, 'utf8')).toBe(input);
      }
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ] as const)(
    'matches canonical Babel ignore-file coverage and reports (loaded=%s, default transform=%s)',
    async (loaded, defaultTransform) => {
      await configureCoverageCollatorAsync(folder);
      await fs.writeFile(path.join(folder, 'source.js'), `/* istanbul ignore file */\n${SOURCE}`);
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        loaded
          ? "test('ignored source', () => expect(require('./source')(true)).toBe('yes'));"
          : "test('untouched ignored source', () => {});"
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js'],
        transform: defaultTransform ? undefined : {},
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json', 'json-summary', 'text-summary']
      });
      const canonicalRun = await runHeftAsync(folder, []);
      if (canonicalRun.code !== 0) throw new Error(canonicalRun.output);
      expect(await readCanonicalCoverageAsync(folder)).toEqual({});
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const { coverage } = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(coverage).toMatchObject({ map: {}, sourceHashes: {}, expectedFiles: [] });
      const collated = await runHeftCommandAsync(
        folder,
        ['run', '--only', 'collate', '--', '--shard-parent-folder=shards', '--shard-count=1'],
        'generation-1'
      );
      if (collated.code !== 0) throw new Error(collated.output);
      for (const filename of ['coverage-final.json', 'coverage-summary.json']) {
        expect(
          JSON.parse(await fs.readFile(path.join(folder, 'temp', 'jest-collated-coverage', filename), 'utf8'))
        ).toEqual(JSON.parse(await fs.readFile(path.join(folder, 'canonical', filename), 'utf8')));
      }
      const summary: RegExp = /(?:Statements|Branches|Functions|Lines)\s*:\s*[^\r\n]+/g;
      expect(canonicalRun.output.match(summary)).toHaveLength(4);
      expect(collated.output.match(summary)).toEqual(canonicalRun.output.match(summary));
    },
    180000
  );

  it.each(['mutated-input', 'stale-original', 'missing-original-content'] as const)(
    'does not exempt unverifiable ignored Babel sources (%s)',
    async (failure) => {
      const ignored: string = `/* istanbul ignore file */\n${SOURCE}`;
      await fs.writeFile(path.join(folder, 'original.js'), `${ignored}// current original\n`);
      const map = {
        version: 3,
        sources: ['original.js'],
        sourcesContent: failure === 'missing-original-content' ? undefined : [ignored],
        names: [],
        mappings: 'AAAA'
      };
      await fs.writeFile(
        path.join(folder, 'source.js'),
        failure === 'mutated-input'
          ? ignored
          : `${ignored}//# sourceMappingURL=data:application/json;base64,${Buffer.from(
              JSON.stringify(map)
            ).toString('base64')}`
      );
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        failure === 'mutated-input'
          ? `test('mutates ignored input', () => {
              require('./source');
              require('fs').appendFileSync(require('path').join(__dirname, 'source.js'), '// changed');
            });`
          : "test('loads ignored source', () => require('./source'));"
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js']
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/does not match disk|Missing trustworthy sourcesContent/);
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it.each([true, false])(
    'does not overwrite an existing HTML reporter target (covered=%s)',
    async (covered) => {
      await configureCoverageCollatorAsync(folder, {
        outputDirectory: 'input',
        reportFilename: 'report.json'
      });
      const identity: string = 'input/report-coverage/sorter.js';
      const target: string = path.join(folder, identity);
      const source: string = 'module.exports = () => 42;\n';
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source);
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        `test('source', () => expect(require('./${identity}')()).toBe(42));`
      );
      await fs.writeFile(path.join(folder, 'other.js'), 'module.exports = 1;\n');
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: covered ? [identity] : ['other.js'],
        coverageReporters: ['html']
      });
      await runShardsAsync(folder);
      for (let attempt: number = 0; attempt < 2; attempt++) {
        const result = await runCollatorAsync(folder);
        expect(result.code).toBe(1);
        expect(result.output).toMatch(/unowned.*manually/i);
        expect(await fs.readFile(target, 'utf8')).toBe(source);
        await expect(fs.readFile(path.join(folder, 'input', 'report.json'))).rejects.toThrow(/ENOENT/);
      }
    },
    180000
  );

  it.each(['complete', 'missing-sibling', 'stale-generation'])(
    'preserves a generated HTML script now used as source with %s shard inputs',
    async (inputState) => {
      await configureCoverageCollatorAsync(folder);
      await writeSourcesAsync(folder);
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js'],
        coverageReporters: ['html']
      });
      const previous: IShardResultManifest[] = await runShardsAsync(folder);
      expect((await runCollatorAsync(folder)).code).toBe(0);
      const identity: string = 'temp/jest-collated-coverage/sorter.js';
      const target: string = path.join(folder, identity);
      const original: string = await fs.readFile(target, 'utf8');
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js', identity],
        coverageReporters: ['html']
      });
      const generation: string = inputState === 'stale-generation' ? 'generation-2' : 'generation-1';
      const current: IShardResultManifest[] = await runShardsAsync(folder, generation);
      expect(current[1].payload).toMatchObject({
        coverage: { sourceHashes: { [identity]: expect.any(String) } }
      });
      const inventoryPath: string = path.join(folder, 'temp', 'jest-collated-coverage.files.json');
      const inventory: string = await fs.readFile(inventoryPath, 'utf8');
      if (inputState !== 'complete') {
        // The surviving/restored old manifests do not mention the newly used source.
        for (const manifest of previous) {
          expect((manifest.payload as IJestShardPayload).coverage.sourceHashes[identity]).toBeUndefined();
          await fs.writeFile(
            getShardManifestPath(path.join(folder, 'shards', String(manifest.shardIndex))),
            JSON.stringify(manifest)
          );
        }
        if (inputState === 'missing-sibling') {
          await fs.unlink(getShardManifestPath(path.join(folder, 'shards', '2')));
        }
      }
      for (let attempt: number = 0; attempt < 2; attempt++) {
        const result = await runCollatorAsync(folder, generation);
        expect(result.code).toBe(1);
        expect(result.output).toMatch(
          inputState === 'complete'
            ? /coverage source.*manually/i
            : inputState === 'missing-sibling'
              ? /no result was found for shard 2 of 2/i
              : /current RUSH_SHARD_GENERATION/
        );
        expect(await fs.readFile(target, 'utf8')).toBe(original);
        expect(await fs.readFile(inventoryPath, 'utf8')).toBe(inventory);
        expect(await fs.readFile(path.join(folder, 'source.js'), 'utf8')).toBe(SOURCE);
        await expect(readReportAsync(folder)).rejects.toThrow(/ENOENT/);
      }
    },
    180000
  );

  it.each([
    ['v8', false],
    ['babel', false],
    ['v8', true],
    ['babel', true]
  ] as const)(
    'matches canonical coverage for a Node shebang (%s, default transform=%s)',
    async (provider, transform) => {
      await writeSourcesAsync(folder);
      await fs.writeFile(path.join(folder, 'source.js'), `#!/usr/bin/env node\n${SOURCE}`);
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        transform: transform ? undefined : {},
        collectCoverageFrom: ['source.js'],
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalResult = await runHeftAsync(folder, []);
      expect(canonicalResult.code).toBe(0);
      const canonical = await readCanonicalCoverageAsync(folder);
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const { coverage } = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(coverage.map).toEqual(canonical);
      expect(coverage.sourceHashes['source.js']).toBe(
        (await readCoverageSourceAsync(folder, 'source.js')).hash
      );
      if (provider === 'v8') expect(coverage.v8).toHaveLength(1);
    },
    180000
  );

  it.each([
    ['v8', false],
    ['babel', false],
    ['babel', true]
  ] as const)(
    'keeps unused source-map originals separate from required coverage locations (%s, mapped directive=%s)',
    async (provider, mappedDirective) => {
      await writeSourcesAsync(folder, false);
      const unusedSource: string = mappedDirective ? "'use strict';\n" : '// no mapped locations\n';
      await fs.writeFile(path.join(folder, 'original.js'), SOURCE);
      await fs.writeFile(path.join(folder, 'unused.js'), unusedSource);
      const map: string = Buffer.from(
        JSON.stringify({
          version: 3,
          sources: ['original.js', 'unused.js'],
          sourcesContent: [SOURCE, unusedSource],
          names: [],
          mappings: mappedDirective ? 'ACAA;ADAA;AACA;AACA;AACA;AACA;AACA' : 'AAAA;AACA;AACA;AACA;AACA;AACA'
        })
      ).toString('base64');
      await fs.writeFile(
        path.join(folder, 'source.js'),
        `${mappedDirective ? unusedSource : ''}${SOURCE}//# sourceMappingURL=data:application/json;base64,${map}`
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js'],
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      expect((await runHeftAsync(folder, [])).code).toBe(0);
      const canonical = await readCanonicalCoverageAsync(folder);
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const { coverage } = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(coverage.map).toEqual(canonical);
      expect(Object.keys(coverage.map!).sort()).toEqual(
        provider === 'babel' ? ['original.js'] : ['original.js', 'unused.js']
      );
      const missing = structuredClone(coverage);
      delete missing.map!['original.js'];
      delete missing.sourceHashes['original.js'];
      expect(() => validateJestCoverage(missing)).toThrow();
      expect((await mergeJestCoverage([coverage])).map).toEqual(coverage.map);
      await fs.writeFile(path.join(folder, 'unused.js'), '// changed unused original\n');
      const stale = await runHeftAsync(folder, managed);
      expect(stale.code).not.toBe(0);
      expect(stale.output).toContain('Captured Jest coverage source does not match disk');
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it.each(['v8', 'babel'] as const)(
    'does not treat arbitrary transforms as shebang normalization (%s)',
    async (provider) => {
      await writeSourcesAsync(folder, false);
      await fs.writeFile(path.join(folder, 'source.js'), `#!/usr/bin/env node\n${SOURCE}`);
      await fs.writeFile(
        path.join(folder, 'transformer.js'),
        `module.exports = { process(code) { return { code: code + '\\n// arbitrary change' }; } };`
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js'],
        transform: { 'source\\.js$': '<rootDir>/transformer.js' }
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/verifiable source map|does not match disk/);
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it.each([false, true])(
    'matches canonical unsharded Jest at 80%% for a nested function (remap=%s)',
    async (remap) => {
      const source: string =
        'function outer(x){ function inner(y){if(y)return 1; return 2;} if(x)return inner(x); return 3; }\n' +
        'module.exports = outer;\n';
      await configureCoverageCollatorAsync(folder);
      let generated: string = source;
      if (remap) {
        await fs.mkdir(path.join(folder, 'src'));
        await fs.writeFile(path.join(folder, 'src', 'original.js'), source);
        const decoded: DecodedSourceMap = {
          version: 3,
          sources: ['src/original.js'],
          sourcesContent: [source],
          names: [],
          // Preserve columns so the nested function's unexecuted false arm remains distinguishable.
          mappings: source
            .split('\n')
            .map((line, index) =>
              Array.from({ length: line.length + 1 }, (unused, column): [number, number, number, number] => [
                column,
                0,
                index,
                column
              ])
            )
        };
        const map: string = Buffer.from(
          JSON.stringify({
            ...decoded,
            mappings: encodedMappings(new TraceMap(decoded))
          })
        ).toString('base64');
        generated += `//# sourceMappingURL=data:application/json;base64,${map}`;
      }
      await fs.writeFile(path.join(folder, 'source.js'), generated);
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        "test('outer true', () => expect(require('./source')(true)).toBe(1));"
      );
      await fs.writeFile(
        path.join(folder, 'two.test.js'),
        "test('outer false', () => expect(require('./source')(false)).toBe(3));"
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'v8',
        collectCoverageFrom: ['source.js'],
        coverageThreshold: { global: { branches: 100 } },
        coverageDirectory: '<rootDir>/canonical',
        coverageReporters: ['json']
      });
      const canonicalResult = await runHeftAsync(folder, []);
      expect(canonicalResult.code).toBe(1);
      expect(canonicalResult.output).toContain('not met: 80%');
      const canonical = createCoverageMap(
        JSON.parse(await fs.readFile(path.join(folder, 'canonical', 'coverage-final.json'), 'utf8'))
      );
      const manifests = await runShardsAsync(folder);
      const merged = await mergeJestCoverage(
        manifests.map((manifest) => validateJestShardManifest(manifest).coverage)
      );
      const identity: string = remap ? 'src/original.js' : 'source.js';
      const canonicalData = canonical.fileCoverageFor(path.join(folder, identity)).toJSON();
      expect(merged.map![identity]).toEqual({ ...canonicalData, path: identity });
      const result = await runCollatorAsync(folder);
      expect(result.code).toBe(1);
      const report = await readReportAsync(folder);
      expect(report.success).toBe(false);
      expect(report.coverage.messages.join('\n')).toContain('not met: 80%');
      const finalMap = createCoverageMap(
        JSON.parse(
          await fs.readFile(
            path.join(folder, 'temp', 'jest-collated-coverage', 'coverage-final.json'),
            'utf8'
          )
        )
      );
      expect(finalMap.getCoverageSummary().branches).toMatchObject({ total: 5, covered: 4, pct: 80 });
    },
    180000
  );

  it.each(['v8', 'babel'] as const)(
    'rejects %s stale embedded originals before committing a manifest',
    async (provider) => {
      await fs.mkdir(path.join(folder, 'src'));
      await fs.writeFile(path.join(folder, 'src', 'original.js'), `${SOURCE}// CURRENT original\n`);
      const map: string = Buffer.from(
        JSON.stringify({
          version: 3,
          sources: ['src/original.js'],
          sourcesContent: [SOURCE],
          names: [],
          mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA'
        })
      ).toString('base64');
      await fs.writeFile(
        path.join(folder, 'source.js'),
        `${SOURCE}//# sourceMappingURL=data:application/json;base64,${map}`
      );
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        "test('executes OLD original', () => require('./source')(true));"
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js']
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('Captured Jest coverage source does not match disk');
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
      // The untested-file collection path must apply the same proof.
      await fs.writeFile(path.join(folder, 'one.test.js'), "test('does not load source', () => {});");
      const baselineResult = await runHeftAsync(folder, managed);
      expect(baselineResult.code).not.toBe(0);
      expect(baselineResult.output).toContain('Captured Jest coverage source does not match disk');
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it.each(['v8', 'babel'] as const)(
    'does not label %s executed code with a source changed during tests',
    async (provider) => {
      await writeSourcesAsync(folder, false);
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        `
      test('mutates after loading', () => {
        require('./source')(true);
        require('fs').writeFileSync(require('path').join(__dirname, 'source.js'), 'module.exports = () => 42;');
      });
    `
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js']
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('Captured Jest coverage source does not match disk');
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it.each(['v8', 'babel'] as const)(
    'rejects conflicting %s original sources across real suite observations',
    async (provider) => {
      const changed: string = `${SOURCE}// second generated input\n`;
      await fs.writeFile(path.join(folder, 'original.js'), SOURCE);
      for (const [name, original] of [
        ['source-a.js', SOURCE],
        ['source-b.js', changed]
      ]) {
        const map = Buffer.from(
          JSON.stringify({
            version: 3,
            sources: ['original.js'],
            sourcesContent: [original],
            names: [],
            mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA'
          })
        ).toString('base64');
        await fs.writeFile(
          path.join(folder, name),
          `${SOURCE}//# sourceMappingURL=data:application/json;base64,${map}`
        );
      }
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        "test('first original', () => require('./source-a')(true));"
      );
      await fs.writeFile(
        path.join(folder, 'two.test.js'),
        `
      test('different original', () => {
        require('fs').writeFileSync(require('path').join(__dirname, 'original.js'), ${JSON.stringify(changed)});
        require('./source-b')(false);
      });
    `
      );
      await fs.writeFile(
        path.join(folder, 'sequencer.js'),
        `
      module.exports = class {
        sort(tests) { return tests.sort((a, b) => a.path.localeCompare(b.path)); }
        shard(tests) { return tests; }
        cacheResults() {}
      };
    `
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source-*.js'],
        testSequencer: '<rootDir>/sequencer.js'
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('Conflicting captured Jest coverage sources across suites');
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it.each(['v8', 'babel'] as const)(
    'checks actual %s source provenance even when a test restores the pre-suite disk contents',
    async (provider) => {
      await writeSourcesAsync(folder, false);
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        `
        test('loads different code, then restores disk', () => {
          const fs = require('fs');
          const filename = require('path').join(__dirname, 'source.js');
          const saved = fs.readFileSync(filename, 'utf8');
          fs.writeFileSync(filename, 'module.exports = () => "changed";');
          expect(require('./source')()).toBe('changed');
          fs.writeFileSync(filename, saved);
        });
      `
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js']
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/differs from its snapshot|does not match disk/);
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it('merges transformed V8 coverage with skipped-sibling baselines using captured originalCode', async () => {
    await writeSourcesAsync(folder, false);
    await fs.writeFile(
      path.join(folder, 'one.test.js'),
      "test('both', () => { require('./source')(true); require('./source')(false); });"
    );
    await fs.writeFile(path.join(folder, 'two.test.js'), "test.skip('skipped sibling', () => {});");
    await fs.writeFile(path.join(folder, 'untested.js'), 'module.exports = () => 42;\n');
    await fs.writeFile(
      path.join(folder, 'transformer.js'),
      `
      module.exports = { process(code, filename) {
        return { code: code + '\\n// transformed', map: {
          version: 3, sources: [filename], names: [], mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA'
        }};
      }};
    `
    );
    await writeConfigAsync(folder, {
      collectCoverage: true,
      coverageProvider: 'v8',
      collectCoverageFrom: ['source.js', 'untested.js'],
      transform: { 'source\\.js$': '<rootDir>/transformer.js' },
      coverageDirectory: '<rootDir>/canonical',
      coverageReporters: ['json']
    });
    const canonicalRun = await runHeftAsync(folder, []);
    expect(canonicalRun.code).toBe(0);
    const canonical = createCoverageMap(
      JSON.parse(await fs.readFile(path.join(folder, 'canonical', 'coverage-final.json'), 'utf8'))
    );
    const manifests = await runShardsAsync(folder);
    expect(manifests.map((manifest) => manifest.itemCount).sort()).toEqual([0, 1]);
    const merged = await mergeJestCoverage(
      manifests.map((manifest) => validateJestShardManifest(manifest).coverage)
    );
    expect(merged.v8!.some((entry) => entry.result.url === 'source.js' && entry.baseline)).toBe(false);
    expect(merged.v8!.find((entry) => entry.result.url === 'source.js')!.source).toContain('// transformed');
    for (const [identity, data] of Object.entries(merged.map!)) {
      expect(data).toEqual({
        ...canonical.fileCoverageFor(path.join(folder, identity)).toJSON(),
        path: identity
      });
    }
  }, 180000);

  it.each(['v8', 'babel'] as const)(
    'retains %s coverage with failed assertions and runtime suites',
    async (provider) => {
      await writeSourcesAsync(folder);
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        "test('fails', () => expect(require('./source')(true)).toBe('wrong'));"
      );
      await fs.writeFile(
        path.join(folder, 'two.test.js'),
        "require('./source')(false); throw new Error('runtime failure');"
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js']
      });
      const result = await runHeftAsync(folder, managed);
      expect(result).toEqual({ code: 0, output: expect.stringContaining('verdict deferred') });
      const payload = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(payload).toMatchObject({ failed: 1, runtimeErrorSuites: 1, success: false });
      expect(createCoverageMap(payload.coverage.map!).getCoverageSummary().lines.pct).toBe(100);
    },
    180000
  );

  it.each(['v8', 'babel'] as const)(
    'uses portable original identities for %s inline source maps',
    async (provider) => {
      await fs.mkdir(path.join(folder, 'src'));
      await fs.writeFile(path.join(folder, 'src', 'original.js'), SOURCE);
      const sourceMap: string = Buffer.from(
        JSON.stringify({
          version: 3,
          file: 'source.js',
          sources: ['src/original.js'],
          sourcesContent: [SOURCE],
          names: [],
          mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA'
        })
      ).toString('base64');
      await fs.writeFile(
        path.join(folder, 'source.js'),
        `${SOURCE}//# sourceMappingURL=data:application/json;base64,${sourceMap}`
      );
      await fs.writeFile(
        path.join(folder, 'one.test.js'),
        "test('both', () => { require('./source')(true); require('./source')(false); });"
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js']
      });
      const result = await runHeftAsync(folder, managed);
      if (result.code !== 0) throw new Error(result.output);
      const payload = validateJestShardManifest(
        await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
      );
      expect(Object.keys(payload.coverage.map!)).toEqual(['src/original.js']);
      expect(payload.coverage.expectedFiles).toEqual(['src/original.js']);
      expect(Object.keys(payload.coverage.sourceHashes)).toEqual(['src/original.js']);
    },
    180000
  );

  it('accepts the default babel-jest transformer without an upstream inputSourceMap', async () => {
    await writeSourcesAsync(folder);
    await writeConfigAsync(folder, {
      collectCoverage: true,
      coverageProvider: 'babel',
      collectCoverageFrom: ['source.js'],
      transform: undefined
    });
    const result = await runHeftAsync(folder, managed);
    if (result.code !== 0) throw new Error(result.output);
    const payload = validateJestShardManifest(
      await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
    );
    expect(payload.coverage.configuration.provider).toBe('babel');
    expect(Object.keys(payload.coverage.map!)).toContain('source.js');
    expect(payload.coverage.sourceHashes['source.js']).toBeDefined();
  }, 180000);

  it.each([
    [false, true],
    [true, true],
    [true, false]
  ])(
    'rejects missing Babel instrumentation (empty map=%s, runtime load=%s)',
    async (emptyMap, runtimeLoad) => {
      await writeSourcesAsync(folder);
      // Directive-like text in a string is not Istanbul's comment-based file exclusion.
      await fs.writeFile(
        path.join(folder, 'source.js'),
        `const marker = '/* istanbul ignore file */';\n${SOURCE}`
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js']
      });
      expect((await runHeftAsync(folder, managed)).code).toBe(0);
      if (!runtimeLoad) {
        for (const filename of ['one.test.js', 'two.test.js']) {
          await fs.writeFile(path.join(folder, filename), "test('without loading source', () => {});");
        }
      }
      await fs.writeFile(
        path.join(folder, 'transformer.js'),
        emptyMap
          ? `module.exports = { canInstrument: true, process(code, filename) {
            return { code, map: { version: 3, sources: [filename], sourcesContent: [code], names: [], mappings: '' } };
          } };`
          : 'module.exports = { canInstrument: true, process(code) { return { code }; } };'
      );
      await writeConfigAsync(folder, {
        collectCoverage: true,
        coverageProvider: 'babel',
        collectCoverageFrom: ['source.js'],
        transform: { '\\.js$': '<rootDir>/transformer.js' }
      });
      const result = await runHeftAsync(folder, managed);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('Missing coverage map');
      await expect(
        tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))
      ).resolves.toBeUndefined();
    },
    180000
  );

  it('fails on Jest V8 untested-file errors even though Jest only logs them', async () => {
    await fs.writeFile(path.join(folder, 'untested.js'), 'module.exports = 1;');
    await fs.writeFile(
      path.join(folder, 'one.test.js'),
      "test('removes source after discovery', () => require('fs').unlinkSync(require('path').join(__dirname, 'untested.js')));"
    );
    await writeConfigAsync(folder, {
      collectCoverage: true,
      coverageProvider: 'v8',
      collectCoverageFrom: ['untested.js']
    });
    const result = await runHeftAsync(folder, managed);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Failed to collect coverage from');
    await expect(tryReadShardResultManifestAsync(path.join(folder, 'shards', '1'))).resolves.toBeUndefined();
  }, 180000);

  it('preserves unsharded coverage/disable semantics without letting managed disable bypass thresholds', async () => {
    await writeSourcesAsync(folder, false);
    const config: Config.InitialOptions = {
      collectCoverage: true,
      coverageProvider: 'v8',
      collectCoverageFrom: ['source.js'],
      coverageThreshold: { global: { lines: 100 } },
      coverageReporters: ['json']
    };
    await writeConfigAsync(folder, config);
    expect((await runHeftAsync(folder, [])).code).not.toBe(0);
    expect((await runHeftAsync(folder, ['--disable-code-coverage'])).code).toBe(0);
    const rejected = await runHeftAsync(folder, [...managed, '--disable-code-coverage']);
    expect(rejected.code).not.toBe(0);
    expect(rejected.output).toContain('cannot bypass required thresholds');
    await writeConfigAsync(folder, { ...config, coverageThreshold: undefined });
    const disabled = await runHeftAsync(folder, [...managed, '--disable-code-coverage']);
    expect(disabled.code).toBe(0);
    const payload = validateJestShardManifest(
      await readShardResultManifestAsync(path.join(folder, 'shards', '1'))
    );
    expect(payload.coverage).toMatchObject({
      configuration: { enabled: false },
      map: null,
      expectedFiles: []
    });
  }, 180000);
});
