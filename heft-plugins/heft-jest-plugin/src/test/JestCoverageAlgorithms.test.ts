// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ScriptCov } from '@bcoe/v8-coverage';
import { createCoverageMap } from 'istanbul-lib-coverage';
import { readConfigs } from 'jest-config';
import type { Test, TestContext } from '@jest/reporters';

import {
  createCoverageConfiguration,
  addV8Coverage,
  convertV8CoverageAsync,
  mergeJestCoverage,
  portableCoverageMap,
  readCoverageSourceAsync,
  validateJestCoverage,
  type IJestCoverage,
  type IJestV8Coverage,
  type ICoverageSource
} from '../JestCoverage';
import {
  captureCoverageSourceMapAsync,
  readInitialBabelCoverage,
  snapshotCoverageInputsAsync,
  verifyCoverageSourceAsync
} from '../JestCoverageSources';
import JestCoverageCollectorReporter, {
  JestCoverageCollector,
  registerJestCoverageCollector
} from '../JestCoverageCollector';
import { createFixtureAsync } from './JestShardTestHelpers';

const NESTED: string =
  'function outer(x){ function inner(y){if(y)return 1; return 2;} if(x)return inner(x); return 3; }\n';
const execFileAsync = promisify(execFile);

interface ICollectedScript {
  source: string;
  result: ScriptCov;
}

async function collectAsync(folder: string, calls: boolean[]): Promise<ICollectedScript> {
  const child = await execFileAsync(
    process.execPath,
    [
      '-e',
      `
    const { Session } = require('node:inspector');
    const { promisify } = require('node:util');
    (async () => {
      const session = new Session(); session.connect();
      const post = promisify(session.post.bind(session));
      await post('Profiler.enable');
      await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      const filename = process.argv[1];
      const source = require('node:fs').readFileSync(filename, 'utf8');
      new (require('node:vm').Script)(source, { filename }).runInThisContext();
      for (const value of JSON.parse(process.argv[2])) outer(value);
      const coverage = await post('Profiler.takePreciseCoverage');
      session.disconnect();
      const url = require('node:url').pathToFileURL(filename).href;
      process.stdout.write(JSON.stringify({ source, result: coverage.result.find(r => r.url === filename || r.url === url) }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
      path.join(folder, 'source.js'),
      JSON.stringify(calls)
    ],
    { timeout: 120000 }
  );
  return JSON.parse(child.stdout);
}

describe('function-scoped raw V8 coverage', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await createFixtureAsync();
    await fs.writeFile(path.join(folder, 'source.js'), NESTED);
  });
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  async function contributionAsync(calls: boolean[]): Promise<IJestCoverage> {
    const captured = await collectAsync(folder, calls);
    expect(captured.result.functions.length).toBeGreaterThan(1);
    const entry: IJestV8Coverage = {
      result: { ...captured.result, url: 'source.js' },
      source: captured.source,
      sourceMap: null,
      baseline: false
    };
    return validateJestCoverage({
      version: 2,
      configuration: createCoverageConfiguration(
        {
          collectCoverage: true,
          coverageProvider: 'v8',
          coverageThreshold: { global: { branches: 100 } }
        },
        folder
      ),
      map: await convertV8CoverageAsync([entry]),
      sourceHashes: { 'source.js': (await readCoverageSourceAsync(folder, 'source.js')).hash },
      expectedFiles: ['source.js'],
      v8: [entry]
    });
  }

  it('does not invent inner-function branch hits from a containing outer range in another process', async () => {
    const first = await contributionAsync([true]);
    const second = await contributionAsync([false]);
    const canonical = await contributionAsync([true, false]);
    const original: IJestCoverage = structuredClone(first);
    const incorrect = createCoverageMap(structuredClone(first.map!));
    incorrect.merge(structuredClone(second.map!));
    expect(incorrect.getCoverageSummary().branches).toMatchObject({ total: 5, covered: 5, pct: 100 });
    const merged = await mergeJestCoverage([first, second]);
    expect(createCoverageMap(merged.map!).getCoverageSummary().branches).toMatchObject({
      total: 5,
      covered: 4,
      pct: 80
    });
    expect(createCoverageMap(merged.map!).getCoverageSummary()).toEqual(
      createCoverageMap(canonical.map!).getCoverageSummary()
    );
    expect(merged.map!['source.js'].branchMap).toEqual(canonical.map!['source.js'].branchMap);
    expect((await mergeJestCoverage([second, first])).map).toEqual(merged.map);
    expect(first).toEqual(original);
  }, 180000);

  it('rejects missing, tampered or uncorrelated raw coverage rather than trusting the duplicate map', async () => {
    const valid = await contributionAsync([true]);
    for (const mutate of [
      (coverage: IJestCoverage) => {
        coverage.v8 = null;
      },
      (coverage: IJestCoverage) => {
        coverage.v8 = [];
      },
      (coverage: IJestCoverage) => {
        coverage.v8![0].result.functions[0].ranges[0].count += 1;
      },
      (coverage: IJestCoverage) => {
        coverage.v8![0].source += '// changed';
      },
      (coverage: IJestCoverage) => {
        coverage.map!['source.js'].b[0][0] += 1;
      }
    ]) {
      const invalid: IJestCoverage = structuredClone(valid);
      mutate(invalid);
      await expect(mergeJestCoverage([invalid])).rejects.toThrow();
    }
  }, 180000);

  it('preserves canonical negative V8 columns without accepting tampered maps or negative Babel locations', async () => {
    const source: string = '#!/usr/bin/env node\n\r\nmodule.exports = (value) => (value ? "yes" : "no");\r\n';
    const executed: string = source.replace(/^#!.*/, '');
    await fs.writeFile(path.join(folder, 'source.js'), source);
    const entry: IJestV8Coverage = {
      result: {
        scriptId: '1',
        url: 'source.js',
        functions: [
          {
            functionName: 'module.exports',
            isBlockCoverage: true,
            ranges: [
              {
                startOffset: executed.indexOf('(value)'),
                endOffset: executed.indexOf(';'),
                count: 1
              }
            ]
          }
        ]
      },
      source,
      sourceMap: null,
      baseline: false
    };
    const { default: createConverter } = await import('v8-to-istanbul');
    const filename: string = path.join(folder, 'source.js');
    const converter = createConverter(filename, 0, { source });
    try {
      await converter.load();
      converter.applyCoverage(entry.result.functions);
      const canonical = createCoverageMap(converter.toIstanbul()).fileCoverageFor(filename).data;
      expect(canonical.fnMap[0].decl.start.column).toBe(-2);
      const contribution: IJestCoverage = validateJestCoverage({
        version: 2,
        configuration: createCoverageConfiguration({ collectCoverage: true, coverageProvider: 'v8' }, folder),
        map: await convertV8CoverageAsync([entry]),
        sourceHashes: { 'source.js': (await readCoverageSourceAsync(folder, 'source.js')).hash },
        expectedFiles: ['source.js'],
        v8: [entry]
      });
      const merged: IJestCoverage = await mergeJestCoverage([contribution]);
      expect(merged.map!['source.js']).toEqual({ ...canonical, path: 'source.js' });

      const tampered: IJestCoverage = structuredClone(contribution);
      tampered.map!['source.js'].fnMap[0].decl.start.column = -3;
      await expect(mergeJestCoverage([tampered])).rejects.toThrow('does not match its raw');
      tampered.map!['source.js'].fnMap[0].decl.start.column = -Number.MAX_SAFE_INTEGER - 1;
      expect(() => validateJestCoverage(tampered)).toThrow('JSON validation failed');

      const babel: IJestCoverage = structuredClone(contribution);
      babel.configuration.provider = 'babel';
      babel.v8 = null;
      expect(() => validateJestCoverage(babel)).toThrow('Invalid Jest coverage location');
    } finally {
      converter.destroy();
    }
  });

  it('compacts repeated scripts without changing nested branch coverage or summed counts', async () => {
    await fs.writeFile(path.join(folder, 'source.js'), `${NESTED}//${'.'.repeat(110000)}\n`);
    const first = await contributionAsync([true]);
    const second = await contributionAsync([false]);
    const pair = await mergeJestCoverage([first, second]);
    const repeated = await mergeJestCoverage(
      Array.from({ length: 20 }, (unused, index) => (index % 2 ? first : second))
    );
    expect(repeated.v8).toHaveLength(1);
    expect(repeated.map!['source.js'].branchMap).toEqual(pair.map!['source.js'].branchMap);
    expect(createCoverageMap(repeated.map!).getCoverageSummary().branches).toMatchObject({
      total: 5,
      covered: 4,
      pct: 80
    });
    for (const [key, counts] of Object.entries(pair.map!['source.js'].b)) {
      expect(repeated.map!['source.js'].b[key]).toEqual(counts.map((count) => count * 10));
    }
    for (const counter of ['s', 'f'] as const) {
      for (const [key, count] of Object.entries(pair.map!['source.js'][counter])) {
        expect(repeated.map!['source.js'][counter][key]).toBe(count * 10);
      }
    }
    expect(Buffer.byteLength(JSON.stringify(repeated))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(pair)) + 1024
    );
  }, 180000);

  it('validates each raw observation before compaction can hide malformed ranges or incompatible sources', async () => {
    const { v8 } = await contributionAsync([true]);
    const valid = v8![0];
    const scripts: Map<string, IJestV8Coverage> = new Map();
    addV8Coverage(scripts, valid);
    const changed = structuredClone(valid);
    changed.source += '// changed';
    expect(() => addV8Coverage(scripts, changed)).toThrow('Incompatible V8');
    const malformed = structuredClone(valid);
    malformed.result.functions[0].ranges[0].count = -1;
    expect(() => addV8Coverage(scripts, malformed)).toThrow('Invalid raw V8');
    const badMap = structuredClone(valid);
    badMap.sourceMap = {
      version: 3,
      sources: ['source.js'],
      sourcesContent: [valid.source],
      names: [],
      mappings: 'AAAA'
    };
    expect(() => addV8Coverage(scripts, badMap)).toThrow('Incompatible V8');
    expect(scripts.size).toBe(1);
    expect(scripts.get('source.js')).toEqual(valid);
  });

  it('captures an immutable eligible inventory once across suite starts and completion', async () => {
    const {
      globalConfig,
      configs: [config]
    } = await readConfigs(
      {
        $0: 'coverage-test',
        _: [],
        config: JSON.stringify({
          rootDir: folder,
          collectCoverageFrom: ['source.js'],
          transform: {}
        }),
        collectCoverage: true,
        coverageProvider: 'v8',
        runInBand: true
      },
      [folder]
    );
    const filename: string = path.join(folder, 'source.js');
    const context = {
      config,
      hasteFS: {
        getAbsoluteFileIterator: () => [filename].values(),
        matchFilesWithGlob: () => []
      }
    } as unknown as TestContext;
    const collector = new JestCoverageCollector();
    collector.configuration = createCoverageConfiguration(
      { collectCoverage: true, coverageProvider: 'v8', collectCoverageFrom: ['source.js'] },
      folder
    );
    const releaseCollector: () => void = registerJestCoverageCollector(config.cacheDirectory, collector);
    const reporter = new JestCoverageCollectorReporter(globalConfig, {
      cacheDirectory: config.cacheDirectory
    });
    const readFile = jest.spyOn(fs, 'readFile');
    try {
      await Promise.all(
        Array.from({ length: 20 }, async (unused, index) => {
          await reporter.onTestFileStart({ context, path: path.join(folder, `${index}.test.js`) } as Test);
        })
      );
      await reporter.onRunComplete(new Set([context]));
      expect(readFile.mock.calls.filter(([file]) => file === filename)).toHaveLength(1);
      expect(collector.completed).toBe(true);
    } finally {
      readFile.mockRestore();
      releaseCollector();
    }
  });

  it('captures eligible files outside the haste inventory without crawling dependencies or overriding Jest exclusions', async () => {
    await fs.mkdir(path.join(folder, 'tests'));
    await fs.mkdir(path.join(folder, 'nested'));
    for (const identity of [
      'setup.js',
      'ignored.js',
      'force.test.js',
      'tests/one.test.js',
      'nested/eligible.js',
      'nested/excluded.js',
      'node_modules/dependency.js'
    ]) {
      await fs.writeFile(path.join(folder, identity), NESTED);
    }
    const {
      globalConfig,
      configs: [config]
    } = await readConfigs(
      {
        $0: 'coverage-test',
        _: [],
        config: JSON.stringify({
          rootDir: folder,
          roots: ['<rootDir>/tests'],
          setupFiles: ['<rootDir>/setup.js'],
          coveragePathIgnorePatterns: ['/node_modules/', 'ignored\\.js$', 'force\\.test\\.js$'],
          forceCoverageMatch: ['**/force.test.js'],
          collectCoverageFrom: ['**/*.js', '!nested/excluded.js'],
          transform: {}
        }),
        collectCoverage: true,
        coverageProvider: 'v8',
        runInBand: true
      },
      [folder]
    );
    const snapshot = await snapshotCoverageInputsAsync(config, globalConfig, [
      path.join(folder, 'source.js')
    ]);
    expect(Object.keys(snapshot).sort()).toEqual(['force.test.js', 'nested/eligible.js', 'source.js']);
    expect(snapshot['nested/eligible.js']).toBe(NESTED);
    await fs.writeFile(path.join(folder, 'nested', 'late.js'), NESTED);
    await fs.writeFile(path.join(folder, 'source.js'), `${NESTED}// changed\n`);
    expect(snapshot['nested/late.js']).toBeUndefined();
    await expect(
      verifyCoverageSourceAsync(folder, 'source.js', snapshot['source.js'], new Map())
    ).rejects.toThrow('does not match disk');
  });

  it('does not replace zero-counter Babel candidate snapshots at later suite starts', async () => {
    const {
      globalConfig,
      configs: [config]
    } = await readConfigs(
      {
        $0: 'coverage-test',
        _: [],
        config: JSON.stringify({
          rootDir: folder,
          collectCoverageFrom: ['source.js'],
          transform: {}
        }),
        collectCoverage: true,
        coverageProvider: 'babel',
        runInBand: true
      },
      [folder]
    );
    const filename: string = path.join(folder, 'source.js');
    await fs.writeFile(filename, `/* istanbul ignore file */\n${NESTED}`);
    const context = {
      config,
      hasteFS: {
        getAbsoluteFileIterator: () => [].values(),
        matchFilesWithGlob: () => []
      }
    } as unknown as TestContext;
    const collector = new JestCoverageCollector();
    collector.configuration = createCoverageConfiguration(
      { collectCoverage: true, coverageProvider: 'babel', collectCoverageFrom: ['source.js'] },
      folder
    );
    const releaseCollector: () => void = registerJestCoverageCollector(config.cacheDirectory, collector);
    const reporter = new JestCoverageCollectorReporter(globalConfig, {
      cacheDirectory: config.cacheDirectory
    });
    const readFile = jest.spyOn(fs, 'readFile');
    try {
      for (let batch: number = 0; batch < 2; batch++) {
        await Promise.all(
          Array.from({ length: 20 }, async (unused, index) => {
            await reporter.onTestFileStart({ context, path: path.join(folder, `${index}.test.js`) } as Test);
          })
        );
        if (batch === 0) await fs.appendFile(filename, '// changed after source capture\n');
      }
      expect(readFile.mock.calls.filter(([file]) => file === filename)).toHaveLength(1);
      await expect(reporter.onRunComplete(new Set([context]))).rejects.toThrow('does not match disk');
      expect(collector.completed).toBe(false);
      expect(collector.expectedFiles.size).toBe(0);
    } finally {
      readFile.mockRestore();
      releaseCollector();
    }
  });

  it.each([false, true])(
    'filters crawled candidates before reading source maps while retaining configured extensions (transform=%s)',
    async (transformed) => {
      await fs.mkdir(path.join(folder, 'tests'));
      await fs.writeFile(
        path.join(folder, 'transformer.js'),
        'module.exports = { process(code) { return { code }; } };'
      );
      for (const identity of ['site.css', 'ignored.custom', 'unknown', 'custom', 'unrelated.CUSTOM']) {
        await fs.writeFile(path.join(folder, identity), '/*# sourceMappingURL=missing.map */\n');
      }
      const sourceMap: string = JSON.stringify({
        version: 3,
        sources: ['original.custom'],
        sourcesContent: [NESTED],
        names: [],
        mappings: 'AAAA'
      });
      const mappedSource: string = `${NESTED}//# sourceMappingURL=source.custom.map\n`;
      await fs.writeFile(path.join(folder, 'source.custom'), mappedSource);
      await fs.writeFile(path.join(folder, 'source.custom.map'), sourceMap);
      await fs.writeFile(path.join(folder, 'source.ts'), NESTED);
      const {
        globalConfig,
        configs: [config]
      } = await readConfigs(
        {
          $0: 'coverage-test',
          _: [],
          config: JSON.stringify({
            rootDir: folder,
            roots: ['<rootDir>/tests'],
            moduleFileExtensions: ['js', 'ts', ...(transformed ? [] : ['custom'])],
            transform: transformed ? { '\\.custom$': '<rootDir>/transformer.js' } : {},
            transformIgnorePatterns: ['ignored\\.custom$'],
            coveragePathIgnorePatterns: ['transformer\\.js$', ...(transformed ? [] : ['ignored\\.custom$'])]
          }),
          collectCoverage: true,
          coverageProvider: 'v8',
          runInBand: true
        },
        [folder]
      );
      const coverageFiles: string[] = [];
      const snapshot = await snapshotCoverageInputsAsync(config, globalConfig, [], coverageFiles);
      expect(Object.keys(snapshot).sort()).toEqual([
        'source.custom',
        'source.custom.map',
        'source.js',
        'source.ts'
      ]);
      expect(snapshot['source.custom']).toBe(mappedSource);
      expect(snapshot['source.custom.map']).toBe(sourceMap);
      expect(snapshot['source.ts']).toBe(NESTED);
      expect(coverageFiles.sort()).toEqual(
        ['source.custom', 'source.js', 'source.ts'].map((filename) => path.join(folder, filename))
      );
    }
  );

  it.each([
    '/* istanbul ignore file */\nmodule.exports = 1;',
    '#!/usr/bin/env node\n/* istanbul ignore file */\nmodule.exports = 1;',
    'module.exports = 1;\n// istanbul ignore file',
    '/* istanbul ignore file: generated code */\nmodule.exports = 1;'
  ])('recognizes a parsed Istanbul file exclusion without inventing counters: %s', (source) => {
    expect(readInitialBabelCoverage(source, path.join(folder, 'source.js'))).toBeUndefined();
  });

  it.each([
    '',
    '// ordinary comment\n',
    "const text = '/* istanbul ignore file */';",
    'const text = `/* istanbul ignore file */`;',
    '/* prefix istanbul ignore file */\nmodule.exports = 1;',
    '/* istanbul ignore next */\nmodule.exports = 1;'
  ])('still requires real instrumentation for non-excluded code: %s', (source) => {
    expect(() => readInitialBabelCoverage(source, path.join(folder, 'source.js'))).toThrow(
      'Missing coverage map'
    );
  });

  it.each([
    '/* c8 ignore next */\nmodule.exports = () => 42;\n',
    '/* v8 ignore start */\nmodule.exports = () => 42;\n/* v8 ignore stop */\n'
  ])('preserves converter ignore semantics for an untested baseline: %s', async (source: string) => {
    await fs.writeFile(path.join(folder, 'source.js'), source);
    const entry: IJestV8Coverage = {
      result: {
        scriptId: '0',
        url: 'source.js',
        functions: [
          {
            functionName: '(empty-report)',
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: Buffer.byteLength(source), count: 0 }]
          }
        ]
      },
      source,
      sourceMap: null,
      baseline: true
    };
    const coverage = validateJestCoverage({
      version: 2,
      configuration: createCoverageConfiguration({ collectCoverage: true, coverageProvider: 'v8' }, folder),
      map: await convertV8CoverageAsync([entry]),
      sourceHashes: { 'source.js': (await readCoverageSourceAsync(folder, 'source.js')).hash },
      expectedFiles: ['source.js'],
      v8: [entry]
    });
    expect(Object.values(coverage.map!['source.js'].s)).toContain(1);
    const merged = await mergeJestCoverage([coverage]);
    expect(merged.map).toEqual(coverage.map);
    coverage.v8![0].result.functions[0].ranges[0].count = 1;
    expect(() => validateJestCoverage(coverage)).toThrow(/baseline/);
  });

  it.each([false, true])(
    'rejects runtime input mismatches before recording conflicting source evidence (restored=%s)',
    async (restored) => {
      const observed: Map<string, ICoverageSource> = new Map();
      const changed: string = `${NESTED}// changed during execution\n`;
      if (!restored) await fs.writeFile(path.join(folder, 'source.js'), changed);
      await expect(
        captureCoverageSourceMapAsync(
          folder,
          path.join(folder, 'source.js'),
          {
            version: 3,
            sources: ['source.js'],
            sourcesContent: [changed],
            names: [],
            mappings: 'AAAA'
          },
          NESTED,
          observed,
          true
        )
      ).rejects.toThrow('differs from its snapshot');
      expect(observed.size).toBe(0);
    }
  );

  it('validates embedded original contents, not a post-collection disk hash', async () => {
    const observed: Map<string, ICoverageSource> = new Map();
    await fs.writeFile(path.join(folder, 'original.js'), NESTED);
    const map = {
      version: 3,
      sources: ['original.js'],
      sourcesContent: [NESTED],
      names: [],
      mappings: 'AAAA'
    };
    await captureCoverageSourceMapAsync(folder, path.join(folder, 'source.js'), map, NESTED, observed);
    const changed = `${NESTED}// new original\n`;
    await fs.writeFile(path.join(folder, 'original.js'), changed);
    await expect(
      captureCoverageSourceMapAsync(folder, path.join(folder, 'source.js'), map, NESTED, new Map())
    ).rejects.toThrow('does not match disk');
    await expect(
      captureCoverageSourceMapAsync(
        folder,
        path.join(folder, 'source.js'),
        { ...map, sourcesContent: [changed] },
        NESTED,
        observed
      )
    ).rejects.toThrow('Conflicting captured');
    await expect(verifyCoverageSourceAsync(folder, 'original.js', NESTED, observed)).rejects.toThrow(
      'does not match disk'
    );
    await expect(
      captureCoverageSourceMapAsync(
        folder,
        path.join(folder, 'source.js'),
        { ...map, sourcesContent: undefined },
        NESTED,
        new Map()
      )
    ).rejects.toThrow('Missing trustworthy sourcesContent');
    await expect(
      captureCoverageSourceMapAsync(
        folder,
        path.join(folder, 'source.js'),
        { ...map, sources: ['source.js'], sourcesContent: undefined },
        NESTED,
        new Map(),
        true
      )
    ).rejects.toThrow('Missing trustworthy sourcesContent');
  });

  it.each([false, true])(
    'replays only the self source normalization and preserves explicit originals (stripped=%s)',
    async (stripped) => {
      const original: string = '#!/usr/bin/env node\nmodule.exports = 1;\n';
      const source: string = '\nmodule.exports = 1;\n';
      const other: string = '#!/usr/bin/env node\n// unmapped original\n';
      await fs.writeFile(path.join(folder, 'source.js'), original);
      await fs.writeFile(path.join(folder, 'other.js'), other);
      const rawMap = {
        version: 3 as const,
        sources: ['source.js', 'other.js'],
        sourcesContent: [stripped ? source : original, other],
        names: [],
        mappings: 'AAAA;AACA'
      };
      const observed: Map<string, ICoverageSource> = new Map();
      const sourceMap = await captureCoverageSourceMapAsync(
        folder,
        path.join(folder, 'source.js'),
        rawMap,
        original,
        observed
      );
      expect(sourceMap.inputShebangRemoved).toBe(stripped ? true : undefined);
      expect(sourceMap.sourcesContent).toEqual([original, other]);
      const entry: IJestV8Coverage = {
        result: {
          scriptId: '1',
          url: 'source.js',
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }]
            }
          ]
        },
        source,
        sourceMap,
        baseline: false
      };
      const before: IJestV8Coverage = structuredClone(entry);
      const actual = await convertV8CoverageAsync([entry]);
      const { default: createConverter } = await import('v8-to-istanbul');
      const converter = createConverter(path.join(folder, 'source.js'), 0, {
        source,
        sourceMap: {
          sourcemap: { ...rawMap, sources: rawMap.sources.map((identity) => path.join(folder, identity)) }
        }
      });
      try {
        await converter.load();
        converter.applyCoverage(entry.result.functions);
        expect(actual).toEqual(
          portableCoverageMap(createCoverageMap(converter.toIstanbul()), folder, observed)
        );
      } finally {
        converter.destroy();
      }
      expect(actual['source.js'].statementMap[0].end.column).toBe(stripped ? 0 : 19);
      expect(actual['other.js'].statementMap[0].end.column).toBe(19);
      expect(entry).toEqual(before);
      const sourceHashes: Record<string, string> = Object.create(null);
      for (const [identity, { hash }] of observed) sourceHashes[identity] = hash;
      const coverage = validateJestCoverage({
        version: 2,
        configuration: createCoverageConfiguration({ collectCoverage: true, coverageProvider: 'v8' }, folder),
        map: actual,
        sourceHashes,
        expectedFiles: Object.keys(actual),
        v8: [entry]
      });
      if (stripped) {
        const ambiguous: IJestCoverage = structuredClone(coverage);
        ambiguous.v8![0].sourceMap!.sources.unshift('source.js');
        ambiguous.v8![0].sourceMap!.sourcesContent.unshift(original);
        expect(() => validateJestCoverage(ambiguous)).toThrow('Invalid captured V8 input shebang');
        await expect(
          captureCoverageSourceMapAsync(
            folder,
            path.join(folder, 'source.js'),
            { ...rawMap, sources: ['source.js', 'source.js'], sourcesContent: [source, original] },
            original,
            new Map()
          )
        ).rejects.toThrow('Ambiguous Jest input shebang');
      }
    }
  );
});
