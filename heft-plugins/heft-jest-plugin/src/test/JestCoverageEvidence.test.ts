// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '@jest/types';
import { readConfigs } from 'jest-config';
import {
  createScriptTransformer,
  type ScriptTransformer,
  type TransformOptions,
  type TransformationOptions,
  type TransformResult
} from '@jest/transform';

import { JestCoverageCollector } from '../JestCoverageCollector';
import { createTransformer, type IJestCoverageTransformerOptions } from '../JestCoverageTransformer';
import {
  getExecutionInputsPath,
  readExecutionInputsAsync,
  recordExecutionInput
} from '../JestCoverageEvidence';
import { createFixtureAsync } from './JestShardTestHelpers';

const SOURCE: string = '/* istanbul ignore file */\nmodule.exports = () => 1;\n';

interface ITransformerFixture {
  original: Config.ProjectConfig;
  managed: Config.ProjectConfig;
  collector: JestCoverageCollector;
}

const CALLER_OPTIONS: Parameters<ScriptTransformer['transformSource']>[2] = {
  instrument: true,
  supportsDynamicImport: false,
  supportsExportNamespaceFrom: true,
  supportsStaticESM: false,
  supportsTopLevelAwait: false
};

describe('attempt-scoped Jest execution-input evidence', () => {
  let folder: string;
  let config: Config.ProjectConfig;
  let managedConfig: Config.ProjectConfig;
  let collector: JestCoverageCollector;

  beforeEach(async () => {
    folder = await createFixtureAsync();
    await fs.writeFile(path.join(folder, 'source.js'), SOURCE);
    const initial: Config.InitialOptions = {
      rootDir: folder,
      cacheDirectory: path.join(folder, 'cache'),
      collectCoverageFrom: ['source.js'],
      transform: {}
    };
    const argv: Config.Argv = {
      _: [],
      $0: 'evidence-test',
      rootDir: folder,
      runInBand: true,
      collectCoverage: true,
      coverageProvider: 'babel'
    };
    ({
      configs: [config]
    } = await readConfigs({ ...argv, config: JSON.stringify(initial) }, [folder]));
    collector = new JestCoverageCollector();
    const managed = await collector.configureExecutionInputsAsync(argv, initial);
    ({
      configs: [managedConfig]
    } = await readConfigs({ ...argv, config: JSON.stringify({ ...initial, ...managed }) }, [folder]));
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  async function configureTransformerAsync(initial: Config.InitialOptions): Promise<ITransformerFixture> {
    const argv: Config.Argv = {
      _: [],
      $0: 'public-transformer-test',
      rootDir: folder,
      runInBand: true,
      collectCoverage: true,
      coverageProvider: 'babel'
    };
    const configuration: Config.InitialOptions = {
      rootDir: folder,
      cacheDirectory: path.join(folder, 'transformer-cache'),
      collectCoverageFrom: ['source.js'],
      ...initial
    };
    const {
      configs: [original]
    } = await readConfigs({ ...argv, config: JSON.stringify(configuration) }, [folder]);
    const inputCollector: JestCoverageCollector = new JestCoverageCollector();
    const settings = await inputCollector.configureExecutionInputsAsync(argv, configuration);
    const {
      configs: [managed]
    } = await readConfigs({ ...argv, config: JSON.stringify({ ...configuration, ...settings }) }, [folder]);
    return { original, managed, collector: inputCollector };
  }

  it('retains an earlier differing observation instead of replacing it with the restored input', async () => {
    for (const source of [SOURCE, SOURCE.replace('=> 1', '=> 2'), SOURCE]) {
      recordExecutionInput(config, collector.attempt, {
        filename: path.join(folder, 'source.js'),
        source,
        instrument: true
      });
    }
    expect(await readExecutionInputsAsync(config, collector.attempt)).toHaveLength(3);
    await expect(collector.validateExecutionInputsAsync()).rejects.toThrow('differs from its snapshot');
    expect(await fs.readFile(path.join(folder, 'source.js'), 'utf8')).toBe(SOURCE);
    await collector.disposeAsync();
    await expect(fs.stat(getExecutionInputsPath(config, collector.attempt))).rejects.toThrow(/ENOENT/);
  });

  it('rejects undeclared inputs even if their final disk contents match an observation', async () => {
    const filename: string = path.join(folder, 'late.js');
    await fs.writeFile(filename, SOURCE);
    recordExecutionInput(config, collector.attempt, { filename, source: SOURCE, instrument: true });
    await expect(collector.validateExecutionInputsAsync()).rejects.toThrow(
      'Missing pre-execution Jest coverage input "late.js"'
    );
  });

  it.each(['empty', 'truncated', 'digest', 'attempt', 'missing', 'hardlink'] as const)(
    'rejects %s execution-input evidence',
    async (failure) => {
      const filename: string = getExecutionInputsPath(config, collector.attempt);
      const original: string = await fs.readFile(filename, 'utf8');
      switch (failure) {
        case 'empty':
          await fs.writeFile(filename, '');
          break;
        case 'truncated':
          await fs.writeFile(filename, original.slice(0, -1));
          break;
        case 'digest':
          await fs.writeFile(filename, original.replace('"payload":"null"', '"payload":"{}"'));
          break;
        case 'attempt':
          await fs.writeFile(
            filename,
            original.replace(collector.attempt, '00000000-0000-0000-0000-000000000000')
          );
          break;
        case 'missing':
          await fs.unlink(filename);
          break;
        case 'hardlink':
          await fs.link(filename, path.join(folder, 'alias'));
          break;
      }
      await expect(collector.validateExecutionInputsAsync()).rejects.toThrow();
    }
  );

  it('does not transform noncoverage JS or add inline source maps when the original config has no transforms', async () => {
    const filename: string = path.join(folder, 'unrelated.js');
    const source: string = `module.exports = 42;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ['original.js'],
        sourcesContent: ['module.exports = 42;'],
        names: [],
        mappings: 'AAAA'
      })
    ).toString('base64')}\n`;
    await fs.writeFile(filename, source);
    const options: TransformationOptions = {
      collectCoverage: true,
      collectCoverageFrom: ['source.js'],
      coverageProvider: 'babel',
      supportsDynamicImport: false,
      supportsExportNamespaceFrom: false,
      supportsStaticESM: false,
      supportsTopLevelAwait: false
    };
    const canonical: TransformResult = (await createScriptTransformer(config)).transform(
      filename,
      options,
      source
    );
    const managed: TransformResult = (await createScriptTransformer(managedConfig)).transform(
      filename,
      options,
      source
    );
    expect(managed).toEqual(canonical);
    expect(managed).toMatchObject({ code: source, sourceMapPath: null });
    expect(await readExecutionInputsAsync(config, collector.attempt)).toEqual([]);
  });

  it('exposes the transformer through the existing public package export', () => {
    expect(require.resolve('@rushstack/heft-jest-plugin/lib/JestCoverageTransformer')).toBe(
      require.resolve('../JestCoverageTransformer')
    );
  });

  it.each(['sync', 'async'] as const)(
    'preserves native Map receivers and shares mutations with the %s runtime',
    async (mode) => {
      const filename: string = path.join(folder, 'source.js');
      const dependency: string = path.join(folder, 'dependency.js');
      const dependencySource: string = 'module.exports = "from the runtime cache";';
      await fs.writeFile(
        path.join(folder, 'native-map-transformer.cjs'),
        `module.exports = { canInstrument: true,
        ${mode === 'async' ? 'async getCacheKeyAsync' : 'getCacheKey'}(code, filename, options) {
          Map.prototype.set.call(options.cacheFS, 'key-phase', filename);
          return code;
        },
        ${mode === 'async' ? 'async processAsync' : 'process'}(code, filename, options) {
        if (Map.prototype.get.call(options.cacheFS, filename) !== code) {
          throw new Error('Lost native Map input');
        }
        if (Map.prototype.get.call(options.cacheFS, 'key-phase') !== filename ||
            !Map.prototype.has.call(options.cacheFS, 'external-change') ||
            Map.prototype.has.call(options.cacheFS, 'external-deletion')) {
          throw new Error('Lost runtime Map sharing');
        }
        if (Map.prototype.set.call(options.cacheFS, 'temporary', code) !== options.cacheFS ||
            !Map.prototype.delete.call(options.cacheFS, 'temporary') ||
            Map.prototype.has.call(options.cacheFS, 'temporary')) {
          throw new Error('Lost native Map mutation');
        }
        const entries = Array.from(Map.prototype.entries.call(options.cacheFS));
        const keys = Array.from(Map.prototype.keys.call(options.cacheFS));
        const values = Array.from(Map.prototype.values.call(options.cacheFS));
        const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(options.cacheFS);
        if (size !== entries.length || keys.length !== size || values.length !== size ||
            Array.from(Map.prototype[Symbol.iterator].call(options.cacheFS)).length !== size) {
          throw new Error('Lost native Map iteration');
        }
        const receiver = {};
        Map.prototype.forEach.call(options.cacheFS, function(value, key, map) {
          if (this !== receiver || map !== options.cacheFS || map.get(key) !== value) {
            throw new Error('Lost forEach receiver');
          }
        }, receiver);
        Map.prototype.set.call(options.cacheFS, ${JSON.stringify(dependency)}, ${JSON.stringify(dependencySource)});
        if (filename === ${JSON.stringify(dependency)}) {
          Map.prototype.clear.call(options.cacheFS);
          Map.prototype.set.call(options.cacheFS, 'cleared', 'yes');
        }
        return { code };
      } };`
      );
      const argv: Config.Argv = {
        _: [],
        $0: 'native-map-test',
        rootDir: folder,
        runInBand: true,
        cacheDirectory: path.join(folder, 'native-map-cache'),
        collectCoverage: true,
        coverageProvider: 'babel'
      };
      const initial: Config.InitialOptions = {
        rootDir: folder,
        cache: false,
        collectCoverageFrom: ['source.js'],
        transform: { '\\.js$': '<rootDir>/native-map-transformer.cjs' }
      };
      const {
        configs: [original]
      } = await readConfigs({ ...argv, config: JSON.stringify(initial) }, [folder]);
      const nativeMapCollector: JestCoverageCollector = new JestCoverageCollector();
      const settings = await nativeMapCollector.configureExecutionInputsAsync(argv, initial);
      try {
        const {
          configs: [managed]
        } = await readConfigs({ ...argv, config: JSON.stringify({ ...initial, ...settings }) }, [folder]);
        const options: Parameters<ScriptTransformer['transformSource']>[2] = {
          instrument: true,
          supportsDynamicImport: mode === 'async',
          supportsExportNamespaceFrom: mode === 'async',
          supportsStaticESM: mode === 'async',
          supportsTopLevelAwait: mode === 'async'
        };
        for (const project of [original, managed]) {
          const cacheFS: Map<string, string> = new Map([
            [filename, SOURCE],
            ['external-deletion', 'old']
          ]);
          const transformer: ScriptTransformer = await createScriptTransformer(project, cacheFS);
          cacheFS.delete('external-deletion');
          cacheFS.set('external-change', 'new');
          const observed: TransformResult =
            mode === 'async'
              ? await transformer.transformSourceAsync(filename, SOURCE, options)
              : transformer.transformSource(filename, SOURCE, options);
          expect(observed.code).toBe(SOURCE);
          expect(cacheFS.get(dependency)).toBe(dependencySource);
          expect(cacheFS.has('temporary')).toBe(false);
          // No fileSource: only the runtime's shared cache can supply the transformer's replacement.
          const runtimeOptions: TransformationOptions = {
            ...options,
            collectCoverage: false,
            collectCoverageFrom: [],
            coverageProvider: 'babel'
          };
          // Jest's runtime transform cache checks mtime before consulting cacheFS.
          await fs.writeFile(dependency, 'throw new Error("Read disk instead of the runtime cache");');
          const loaded: TransformResult =
            mode === 'async'
              ? await transformer.transformAsync(dependency, runtimeOptions)
              : transformer.transform(dependency, runtimeOptions);
          expect(loaded.code).toBe(dependencySource);
          expect([...cacheFS]).toEqual([['cleared', 'yes']]);
        }
      } finally {
        await nativeMapCollector.disposeAsync();
      }
    }
  );

  it.each([
    ['sync', true],
    ['async', true],
    ['sync', false],
    ['async', false]
  ] as const)(
    'preserves %s factory options, upstream invalidation and process reuse (cache=%s)',
    async (mode, cache) => {
      const transformerPath: string = path.join(folder, 'factory.cjs');
      const filename: string = path.join(folder, 'source.js');
      await fs.writeFile(
        transformerPath,
        `'use strict';
        const fs = require('fs');
        const path = require('path');
        module.exports = { async createTransformer(settings) {
          if (settings.nested.z !== 1 || settings.nested.a !== 2) throw new Error('Lost factory settings');
          await Promise.resolve();
          const token = {};
          function observe(phase, code, filename, options) {
            if (options.transformerConfig !== settings) throw new Error('Changed factory config identity');
            fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({
              phase, code, config: options.config, configString: options.configString,
              transformerConfig: options.transformerConfig, instrument: options.instrument,
              supportsDynamicImport: options.supportsDynamicImport,
              supportsExportNamespaceFrom: options.supportsExportNamespaceFrom,
              supportsStaticESM: options.supportsStaticESM,
              supportsTopLevelAwait: options.supportsTopLevelAwait
            }) + '\\n');
            Map.prototype.set.call(options.cacheFS, 'seen-' + phase, filename);
          }
          return { canInstrument: true, token,
            getCacheKey(code, filename, options) {
              if (this.token !== token) throw new Error('Lost sync key receiver');
              observe('key-sync', code, filename, options);
              return code + fs.readFileSync(path.join(__dirname, 'token'), 'utf8') + options.configString;
            },
            async getCacheKeyAsync(code, filename, options) {
              if (this !== undefined) throw new Error('Changed async key receiver');
              await Promise.resolve();
              observe('key-async', code, filename, options);
              return code + fs.readFileSync(path.join(__dirname, 'token'), 'utf8') + options.configString;
            },
            process(code, filename, options) {
              if (this.token !== token) throw new Error('Lost sync process receiver');
              observe('process-sync', code, filename, options);
              return { code, map: {
                version: 3, sources: [filename], sourcesContent: [code], names: [], mappings: 'AAAA'
              } };
            },
            async processAsync(code, filename, options) {
              if (this !== undefined) throw new Error('Changed async process receiver');
              await Promise.resolve();
              observe('process-async', code, filename, options);
              return { code, map: {
                version: 3, sources: [filename], sourcesContent: [code], names: [], mappings: 'AAAA'
              } };
            }
          };
        } };`
      );
      const fixture: ITransformerFixture = await configureTransformerAsync({
        cache,
        globals: { z: 1, a: { z: 2, a: 3 } },
        transform: { 'source\\.js$': [transformerPath, { nested: { z: 1, a: 2 } }] }
      });
      const log: string = path.join(folder, 'calls.jsonl');
      const options: typeof CALLER_OPTIONS = {
        ...CALLER_OPTIONS,
        supportsDynamicImport: mode === 'async',
        supportsStaticESM: mode === 'async',
        supportsTopLevelAwait: mode === 'async'
      };
      const observations: unknown[][] = [];
      try {
        for (const project of [fixture.original, fixture.managed]) {
          await fs.writeFile(log, '');
          // Compare independent cold/warm sequences, without removing the attempt evidence.
          for (const entry of await fs.readdir(project.cacheDirectory, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.startsWith('jest-transform-cache-')) {
              await fs.rm(path.join(project.cacheDirectory, entry.name), { recursive: true });
            }
          }
          // Each request uses a fresh ScriptTransformer and runtime Map, not an in-memory result cache.
          for (const token of ['first', 'first', 'invalidated']) {
            await fs.writeFile(path.join(folder, 'token'), token);
            const cacheFS: Map<string, string> = new Map([[filename, SOURCE]]);
            const transformer: ScriptTransformer = await createScriptTransformer(project, cacheFS);
            const result: TransformResult =
              mode === 'async'
                ? await transformer.transformSourceAsync(filename, SOURCE, options)
                : transformer.transformSource(filename, SOURCE, options);
            expect(result.code).toBe(SOURCE);
            expect(JSON.parse(await fs.readFile(result.sourceMapPath!, 'utf8'))).toMatchObject({
              sources: [filename],
              sourcesContent: [SOURCE]
            });
            expect(cacheFS.get(`seen-key-${mode}`)).toBe(filename);
          }
          const calls: Array<{ phase: string }> = (await fs.readFile(log, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(calls.filter(({ phase }) => phase === `key-${mode}`)).toHaveLength(3);
          expect(calls.filter(({ phase }) => phase === `process-${mode}`)).toHaveLength(cache ? 2 : 3);
          observations.push(calls);
        }
        // Includes exact configString, original config, factory config and every caller flag.
        expect(observations[1]).toEqual(observations[0]);
        const inputs = await readExecutionInputsAsync(fixture.original, fixture.collector.attempt);
        expect(inputs.filter((input) => input.code !== undefined)).toHaveLength(3);
      } finally {
        await fixture.collector.disposeAsync();
      }
    }
  );

  it('isolates overlapping public async requests without retaining or rebinding a runtime Map', async () => {
    const filename: string = path.join(folder, 'source.js');
    const transformerPath: string = path.join(folder, 'overlapping.cjs');
    await fs.writeFile(
      transformerPath,
      `module.exports = { canInstrument: true,
        async getCacheKeyAsync(code, filename, options) {
          await new Promise(resolve => setTimeout(resolve, 5));
          return Map.prototype.get.call(options.cacheFS, 'request');
        },
        async processAsync(code, filename, options) {
          const request = Map.prototype.get.call(options.cacheFS, 'request');
          await new Promise(resolve => setTimeout(resolve, 5));
          if (Map.prototype.get.call(options.cacheFS, 'request') !== request) throw new Error('Changed Map');
          Map.prototype.set.call(options.cacheFS, 'processed', request);
          return { code: code + '// ' + request };
        }
      };`
    );
    const fixture: ITransformerFixture = await configureTransformerAsync({
      cache: false,
      transform: { 'source\\.js$': transformerPath }
    });
    try {
      const settings: IJestCoverageTransformerOptions = fixture.managed
        .transform[0][2] as IJestCoverageTransformerOptions;
      const wrapper = await createTransformer(settings);
      const requests: TransformOptions[] = ['first', 'second'].map((request) => ({
        ...CALLER_OPTIONS,
        cacheFS: new Map([
          [filename, SOURCE],
          ['request', request]
        ]),
        config: fixture.managed,
        configString: JSON.stringify(fixture.managed),
        transformerConfig: settings
      }));
      const results = await Promise.all(
        requests.map(async (options) => {
          await wrapper.getCacheKeyAsync!(SOURCE, filename, options);
          return await wrapper.processAsync!(SOURCE, filename, options);
        })
      );
      expect(results.map(({ code }) => code)).toEqual([`${SOURCE}// first`, `${SOURCE}// second`]);
      expect(requests.map(({ cacheFS }) => cacheFS.get('processed'))).toEqual(['first', 'second']);
    } finally {
      await fixture.collector.disposeAsync();
    }
  });

  it.each([false, true])(
    'preserves concurrent same-runtime, same-input transformations with cache=%s',
    async (cache) => {
      const filename: string = path.join(folder, 'source.js');
      const fixture: ITransformerFixture = await configureTransformerAsync({ cache, transform: {} });
      try {
        const expected: string[][] = [];
        for (const project of [fixture.original, fixture.managed]) {
          const transformer: ScriptTransformer = await createScriptTransformer(
            project,
            new Map([[filename, SOURCE]])
          );
          for (let iteration: number = 0; iteration < 2; iteration++) {
            const results: TransformResult[] = await Promise.all([
              transformer.transformSourceAsync(filename, SOURCE, CALLER_OPTIONS),
              transformer.transformSourceAsync(filename, SOURCE, CALLER_OPTIONS)
            ]);
            const codes: string[] = results.map(({ code }) => code);
            if (project === fixture.original) {
              expected.push(codes);
            } else {
              expect(codes).toEqual(expected[iteration]);
            }
          }
        }
      } finally {
        await fixture.collector.disposeAsync();
      }
    }
  );

  it('lets Jest reject corrupt cached code and regenerate proof through the upstream process', async () => {
    const filename: string = path.join(folder, 'source.js');
    const transformerPath: string = path.join(folder, 'checksum.cjs');
    await fs.writeFile(
      transformerPath,
      `module.exports = { canInstrument: true,
        getCacheKey() { return 'checksum'; },
        process(code) {
          require('fs').appendFileSync(__dirname + '/process.log', 'process\\n');
          return { code };
        }
      };`
    );
    const fixture: ITransformerFixture = await configureTransformerAsync({
      transform: { 'source\\.js$': transformerPath }
    });
    try {
      (await createScriptTransformer(fixture.managed)).transformSource(filename, SOURCE, CALLER_OPTIONS);
      const folders: string[] = [fixture.managed.cacheDirectory];
      let corrupted: number = 0;
      while (folders.length) {
        const current: string = folders.pop()!;
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          const candidate: string = path.join(current, entry.name);
          if (entry.isDirectory()) folders.push(candidate);
          else if (entry.isFile() && /^source_[a-f0-9]+$/.test(entry.name)) {
            const cached: string = await fs.readFile(candidate, 'utf8');
            expect(cached.slice(33)).toBe(SOURCE);
            await fs.writeFile(candidate, `${cached.slice(0, 33)}throw new Error('corrupt');`);
            corrupted++;
          }
        }
      }
      expect(corrupted).toBe(2);
      const result: TransformResult = (await createScriptTransformer(fixture.managed)).transformSource(
        filename,
        SOURCE,
        CALLER_OPTIONS
      );
      expect(result.code).toBe(SOURCE);
      expect(await fs.readFile(path.join(folder, 'process.log'), 'utf8')).toBe('process\nprocess\n');
      await fixture.collector.validateExecutionInputsAsync();
    } finally {
      await fixture.collector.disposeAsync();
    }
  });

  it('observes differing source on a persisted cache hit even when the upstream key does not change', async () => {
    const filename: string = path.join(folder, 'source.js');
    const transformerPath: string = path.join(folder, 'constant-key.cjs');
    await fs.writeFile(
      transformerPath,
      `module.exports = { canInstrument: true,
        getCacheKey() { return 'constant'; },
        process() {
          require('fs').appendFileSync(__dirname + '/process.log', 'process\\n');
          return { code: ${JSON.stringify(SOURCE)} };
        }
      };`
    );
    const initial: Config.InitialOptions = { transform: { 'source\\.js$': transformerPath } };
    const first: ITransformerFixture = await configureTransformerAsync(initial);
    (await createScriptTransformer(first.managed)).transformSource(filename, SOURCE, CALLER_OPTIONS);
    await first.collector.validateExecutionInputsAsync();
    await first.collector.disposeAsync();
    const second: ITransformerFixture = await configureTransformerAsync(initial);
    const changed: string = SOURCE.replace('=> 1', '=> 2');
    try {
      const result: TransformResult = (await createScriptTransformer(second.managed)).transformSource(
        filename,
        changed,
        CALLER_OPTIONS
      );
      expect(result.code).toBe(SOURCE);
      expect(await fs.readFile(path.join(folder, 'process.log'), 'utf8')).toBe('process\n');
      expect(await readExecutionInputsAsync(second.original, second.collector.attempt)).toContainEqual({
        filename,
        source: changed,
        code: SOURCE,
        instrument: true
      });
      await expect(second.collector.validateExecutionInputsAsync()).rejects.toThrow(
        'differs from its snapshot'
      );
    } finally {
      await second.collector.disposeAsync();
    }
  });

  it.each(['async-only', 'throw', 'invalid-result', 'no-instrumentation'] as const)(
    'retains the canonical %s error without a successful output observation',
    async (failure) => {
      const filename: string = path.join(folder, 'source.js');
      const transformerPath: string = path.join(folder, 'error.cjs');
      await fs.writeFile(
        transformerPath,
        `module.exports = { canInstrument: true,
          ${failure === 'async-only' ? 'async processAsync' : 'process'}() {
            ${failure === 'throw' ? 'throw new Error("Original transform failure");' : ''}
            return ${failure === 'invalid-result' ? '"invalid"' : '{ code: "module.exports = 1;" }'};
          }
        };`
      );
      const fixture: ITransformerFixture = await configureTransformerAsync({
        cache: false,
        transform: { 'source\\.js$': transformerPath }
      });
      try {
        if (failure === 'no-instrumentation') {
          (await createScriptTransformer(fixture.managed)).transformSource(filename, SOURCE, CALLER_OPTIONS);
          await expect(fixture.collector.validateExecutionInputsAsync()).rejects.toThrow(
            'Babel instrumentation was not produced'
          );
        } else {
          for (const project of [fixture.original, fixture.managed]) {
            const transformer: ScriptTransformer = await createScriptTransformer(project);
            expect(() => transformer.transformSource(filename, SOURCE, CALLER_OPTIONS)).toThrow(
              failure === 'throw'
                ? 'Original transform failure'
                : failure === 'async-only'
                  ? 'must export a `process` function'
                  : 'Invalid return value'
            );
          }
          const inputs = await readExecutionInputsAsync(fixture.original, fixture.collector.attempt);
          expect(inputs).toEqual([{ filename, source: SOURCE, instrument: true }]);
        }
      } finally {
        await fixture.collector.disposeAsync();
      }
    }
  );
});
