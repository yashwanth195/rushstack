// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { format } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { AggregatedResult, Config, Reporter, Test, TestContext, TestResult } from '@jest/reporters';
import { readConfigs } from 'jest-config';
import {
  createScriptTransformer,
  shouldInstrument,
  type ScriptTransformer,
  type TransformResult
} from '@jest/transform';

import {
  coverageIdentity,
  addV8Coverage,
  convertV8CoverageAsync,
  normalizeJestCoverageInput,
  portableCoverageMap,
  validateJestCoverage,
  type IJestCoverage,
  type IJestCoverageConfiguration,
  type ICoverageSource,
  type IJestV8Coverage,
  type IJestCoverageSourceMap
} from './JestCoverage';
import { recoverRuntimeCoverageAsync } from './JestCoverageRunner';
import {
  initializeExecutionInputsAsync,
  readExecutionInputsAsync,
  removeExecutionInputsAsync
} from './JestCoverageEvidence';
import { getManagedJestExecutionKey } from './JestCompletionEvidence';
import { originalCoverageConfig, type IJestCoverageTransformerOptions } from './JestCoverageTransformer';
import {
  captureCoverageSourceMapAsync,
  expectedBabelCoverageFilesAsync,
  readInitialBabelCoverage,
  readCapturedSourceMapAsync,
  snapshotCoverageInputsAsync,
  sourceMapFromInput,
  verifyCoverageSourceAsync,
  type IBabelCoverageData
} from './JestCoverageSources';

const COVERAGE_ERROR: RegExp = /Failed to collect coverage from|Failed to write coverage reports/;
const ACTIVE_COLLECTORS: Set<JestCoverageCollector> = new Set();
const ACTIVE_COLLECTORS_BY_CACHE_DIRECTORY: Map<string, JestCoverageCollector> = new Map();
let originalConsoleError: typeof console.error | undefined;

export function registerJestCoverageCollector(
  cacheDirectory: string,
  collector: JestCoverageCollector
): () => void {
  const key: string = getManagedJestExecutionKey(cacheDirectory);
  if (ACTIVE_COLLECTORS_BY_CACHE_DIRECTORY.has(key)) {
    throw new Error('Duplicate managed Jest coverage collector.');
  }
  ACTIVE_COLLECTORS_BY_CACHE_DIRECTORY.set(key, collector);
  let released: boolean = false;
  return () => {
    if (released) return;
    if (ACTIVE_COLLECTORS_BY_CACHE_DIRECTORY.get(key) !== collector) {
      throw new Error('Inconsistent managed Jest coverage collector.');
    }
    ACTIVE_COLLECTORS_BY_CACHE_DIRECTORY.delete(key);
    released = true;
  };
}

/**
 * Jest 30's public CoverageReporter logs untested-file/report errors without setting getLastError().
 * Keep the original output, but fail every active managed collection rather than accepting partial data.
 * One shared hook avoids out-of-order restoration when Heft tasks overlap in the same process.
 */
export async function observeCoverageErrorsAsync<T>(
  collector: JestCoverageCollector,
  action: () => Promise<T>
): Promise<T> {
  /* eslint-disable no-console -- Observe Jest's otherwise-unreported coverage errors without hiding their output. */
  if (!ACTIVE_COLLECTORS.size) {
    originalConsoleError = console.error;
    console.error = (...args: unknown[]): void => {
      const message: string = format(...args);
      if (COVERAGE_ERROR.test(message)) {
        for (const active of ACTIVE_COLLECTORS) active.errors.push(message);
      }
      originalConsoleError!(...args);
    };
  }
  ACTIVE_COLLECTORS.add(collector);
  try {
    return await action();
  } finally {
    ACTIVE_COLLECTORS.delete(collector);
    if (!ACTIVE_COLLECTORS.size) {
      console.error = originalConsoleError!;
      originalConsoleError = undefined;
    }
  }
}
/* eslint-enable no-console */

export class JestCoverageCollector {
  public readonly attempt: string = randomUUID();
  public readonly errors: string[] = [];
  public configuration!: IJestCoverageConfiguration;
  public completed: boolean = false;
  public readonly sources: Map<string, ICoverageSource> = new Map();
  public readonly expectedFiles: Set<string> = new Set();
  public readonly v8: Map<string, IJestV8Coverage> = new Map();
  public readonly executionFiles: Set<string> = new Set();
  public inputsSnapshot: IJestCoverageInputsSnapshot | undefined;
  private _executionConfig: Config.ProjectConfig | undefined;

  public async configureExecutionInputsAsync(
    argv: Config.Argv,
    config: Config.InitialOptions
  ): Promise<Pick<Config.InitialOptions, 'transform' | 'transformIgnorePatterns'>> {
    const {
      configs: [originalConfig],
      globalConfig
    } = await readConfigs(
      {
        ...argv,
        reporters: argv.reporters ? [...argv.reporters] : undefined,
        config: JSON.stringify(config)
      },
      [argv.rootDir!]
    );
    const files: string[] = [];
    const inputs: Record<string, string> = await snapshotCoverageInputsAsync(
      originalConfig,
      globalConfig,
      [],
      files
    );
    this.inputsSnapshot = Object.freeze({ inputs: Object.freeze(inputs), files: Object.freeze(files) });
    await initializeExecutionInputsAsync(originalConfig, this.attempt);
    this._executionConfig = originalConfig;
    const settings: IJestCoverageTransformerOptions = {
      originalConfig,
      coverageOptions: {
        collectCoverage: globalConfig.collectCoverage,
        collectCoverageFrom: globalConfig.collectCoverageFrom,
        coverageProvider: globalConfig.coverageProvider
      },
      attempt: this.attempt
    };
    // Escape regex syntax only: Jest treats unnecessary escapes (e.g. "\:" or "\-"
    // from Text.escapeRegExp) as Windows path separators during normalization.
    const eligiblePattern: string = files
      .map((filename) => filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const outsideSnapshot: string = `^(?!(?:${eligiblePattern || '(?!)'})$)`;
    // Lift ignores only for frozen coverage candidates. Leaving noncoverage files on their
    // native path matters: even an identity transform can change inline-map/stack semantics.
    // Babel calls getCacheKey before checking ignores, so undeclared instrumented inputs
    // still leave evidence (and are rejected), including ignored, mapless custom transforms.
    const transformIgnorePatterns: string[] = originalConfig.transform.length
      ? originalConfig.transformIgnorePatterns.length
        ? [`${outsideSnapshot}(?=[\\s\\S]*(?:${originalConfig.transformIgnorePatterns.join('|')}))`]
        : []
      : [outsideSnapshot];
    return {
      transform: {
        '^': [require.resolve('@rushstack/heft-jest-plugin/lib/JestCoverageTransformer'), settings]
      },
      transformIgnorePatterns
    };
  }

  public async validateExecutionInputsAsync(): Promise<void> {
    if (!this._executionConfig) return;
    for (const observation of await readExecutionInputsAsync(this._executionConfig, this.attempt)) {
      const identity: string = coverageIdentity(this._executionConfig.rootDir, observation.filename);
      const input: string | undefined = this.inputsSnapshot!.inputs[identity];
      if (input === undefined) throw new Error(`Missing pre-execution Jest coverage input "${identity}".`);
      if (observation.source !== input && observation.source !== normalizeJestCoverageInput(input)) {
        throw new Error(`Executed Jest coverage input differs from its snapshot: "${identity}".`);
      }
      if (observation.instrument && observation.code !== undefined) {
        readInitialBabelCoverage(observation.code, observation.filename);
        this.executionFiles.add(path.resolve(observation.filename));
      }
    }
  }

  public async disposeAsync(): Promise<void> {
    if (this._executionConfig) {
      await removeExecutionInputsAsync(this._executionConfig, this.attempt);
      this._executionConfig = undefined;
    }
  }

  public async completeAsync(results: AggregatedResult, buildFolderPath: string): Promise<IJestCoverage> {
    const coverage: IJestCoverage = {
      version: 2,
      configuration: this.configuration,
      map: null,
      sourceHashes: Object.create(null),
      expectedFiles: [],
      v8: this.configuration.enabled && this.configuration.provider === 'v8' ? [...this.v8.values()] : null
    };
    if (!this.completed || this.errors.length) {
      throw new Error(`Jest coverage collection did not complete: ${this.errors.join('\n')}`);
    }
    if (!this.configuration.enabled) return validateJestCoverage(coverage);
    await this.validateExecutionInputsAsync();
    if (!results.coverageMap) throw new Error('Jest did not return the requested coverage map.');
    for (const [identity, source] of this.sources) {
      await verifyCoverageSourceAsync(buildFolderPath, identity, source.text, this.sources);
    }
    coverage.map =
      coverage.v8 !== null
        ? await convertV8CoverageAsync(coverage.v8)
        : portableCoverageMap(results.coverageMap, buildFolderPath, this.sources);
    for (const identity of Object.keys(coverage.map)) {
      const source: ICoverageSource | undefined = this.sources.get(identity);
      if (!source) throw new Error(`Missing captured original Jest coverage source "${identity}".`);
      coverage.sourceHashes[identity] = source.hash;
    }
    coverage.expectedFiles = [...this.expectedFiles].sort();
    return validateJestCoverage(coverage);
  }
}

interface IJestCoverageReporterOptions {
  cacheDirectory: string;
}

interface IJestCoverageInputsSnapshot {
  readonly inputs: Readonly<Record<string, string>>;
  readonly files: readonly string[];
}

/** Observes public reporter events before Jest releases each suite's raw coverage. */
export default class JestCoverageCollectorReporter implements Reporter {
  private readonly _collector: JestCoverageCollector;
  private readonly _globalConfig: Config.GlobalConfig;
  private readonly _inputsByConfig: Map<Config.ProjectConfig, Promise<IJestCoverageInputsSnapshot>> =
    new Map();
  private readonly _coveredScripts: Set<string> = new Set();
  private readonly _runtimeMappedScripts: Set<string> = new Set();

  public constructor(globalConfig: Config.GlobalConfig, options: IJestCoverageReporterOptions) {
    const collector: JestCoverageCollector | undefined = ACTIVE_COLLECTORS_BY_CACHE_DIRECTORY.get(
      getManagedJestExecutionKey(options.cacheDirectory)
    );
    if (!collector) throw new Error('Missing managed Jest coverage collector.');
    this._collector = collector;
    this._globalConfig = globalConfig;
    if (
      globalConfig.collectCoverage !== collector.configuration.enabled ||
      globalConfig.coverageProvider !== collector.configuration.provider
    ) {
      throw new Error('Normalized Jest coverage configuration does not match the managed request.');
    }
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  public async onTestFileStart(test: Test): Promise<void> {
    if (this._collector.configuration.enabled) {
      await this._getInputsAsync(test.context);
    }
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  public async onTestResult(test: Test, result: TestResult): Promise<void> {
    if (!this._collector.configuration.enabled) return;
    const pendingInputs: Promise<IJestCoverageInputsSnapshot> | undefined = this._inputsByConfig.get(
      test.context.config
    );
    if (!pendingInputs) throw new Error('Missing pre-execution Jest coverage source snapshot.');
    const { inputs } = await pendingInputs;
    let runtimeSourceMaps: Record<string, unknown> | undefined;
    if (result.testExecError || this._collector.configuration.provider === 'babel') {
      runtimeSourceMaps = await recoverRuntimeCoverageAsync(
        test.context.config,
        this._collector.attempt,
        result,
        this._collector.configuration.provider
      );
    }
    for (const [filename, rawMap] of Object.entries(runtimeSourceMaps ?? {})) {
      if (result.coverage?.[filename]) continue;
      this._runtimeMappedScripts.add(filename);
      const identity: string = coverageIdentity(test.context.config.rootDir, filename);
      const input: string | undefined = inputs[identity];
      if (input === undefined) throw new Error(`Missing pre-execution Jest coverage input "${identity}".`);
      // Ignore-file instrumentation has no counters. Its runtime map still records the actual
      // transform input, which a later independent transform cannot recover after disk restoration.
      await captureCoverageSourceMapAsync(
        test.context.config.rootDir,
        filename,
        rawMap,
        input,
        this._collector.sources,
        true
      );
      await this._observeSourceAsync(
        test.context.config,
        filename,
        input,
        sourceMapFromInput(test.context.config.rootDir, filename, input, inputs)
      );
    }
    for (const entry of result.v8Coverage ?? []) {
      const filename: string = entry.result.url;
      const identity: string = coverageIdentity(test.context.config.rootDir, filename);
      const input: string | undefined = inputs[identity];
      if (input === undefined) throw new Error(`Missing pre-execution Jest coverage input "${identity}".`);
      const transform: typeof entry.codeTransformResult = entry.codeTransformResult;
      const normalizedInput: string = normalizeJestCoverageInput(input);
      if (transform && transform.originalCode !== normalizedInput) {
        throw new Error(`Executed Jest coverage input differs from its snapshot: "${identity}".`);
      }
      const source: string = transform?.code ?? input;
      let rawMap: unknown = transform?.sourceMapPath
        ? await readCapturedSourceMapAsync(transform.sourceMapPath, true)
        : undefined;
      rawMap ??= sourceMapFromInput(test.context.config.rootDir, filename, source, inputs);
      if (!rawMap && source !== input && source !== normalizedInput) {
        throw new Error(`Transformed V8 coverage requires a verifiable source map: "${identity}".`);
      }
      const sourceMap: IJestCoverageSourceMap | null = await this._observeSourceAsync(
        test.context.config,
        filename,
        input,
        rawMap
      );
      addV8Coverage(this._collector.v8, {
        result: { ...entry.result, url: identity },
        source: sourceMap ? source : input,
        sourceMap,
        baseline: false
      });
      this._coveredScripts.add(filename);
    }
    for (const [filename, raw] of Object.entries(result.coverage ?? {})) {
      const identity: string = coverageIdentity(test.context.config.rootDir, filename);
      const input: string | undefined = inputs[identity];
      if (input === undefined) throw new Error(`Missing pre-execution Jest coverage input "${identity}".`);
      const inputSourceMap: unknown = (raw as typeof raw & { inputSourceMap?: unknown }).inputSourceMap;
      const instrumentationMap: unknown = runtimeSourceMaps?.[filename];
      if (!instrumentationMap) throw new Error(`Missing captured Babel instrumentation map: "${identity}".`);
      // Unlike the reporter's Istanbul data, the runtime's public source-map registry retains
      // the instrumenter's actual input text, including when no inputSourceMap was necessary.
      const capturedInstrumentationMap: IJestCoverageSourceMap = await captureCoverageSourceMapAsync(
        test.context.config.rootDir,
        filename,
        instrumentationMap,
        input,
        this._collector.sources,
        true
      );
      if (
        !inputSourceMap &&
        (capturedInstrumentationMap.sources.length !== 1 ||
          capturedInstrumentationMap.sources[0] !== identity ||
          capturedInstrumentationMap.sourcesContent[0] !== input ||
          sourceMapFromInput(test.context.config.rootDir, filename, input, inputs))
      ) {
        throw new Error(`Transformed Babel coverage requires a verifiable inputSourceMap: "${identity}".`);
      }
      await this._observeBabelCoverageAsync(test.context.config, filename, input, raw, true);
      this._coveredScripts.add(filename);
    }
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  public async onRunComplete(contexts: Set<TestContext>): Promise<void> {
    const globalConfig: Config.GlobalConfig = this._globalConfig;
    if (globalConfig.collectCoverage) {
      await this._collector.validateExecutionInputsAsync();
      for (const context of contexts) {
        const { inputs, files } = await this._getInputsAsync(context);
        const config: Config.ProjectConfig = originalCoverageConfig(context.config);
        const untestedFiles: Set<string> = new Set(
          context.hasteFS.matchFilesWithGlob(globalConfig.collectCoverageFrom, context.config.rootDir)
        );
        let transformer: ScriptTransformer | undefined;
        // Counters and runtime source maps are not a complete loaded-file inventory. Validate all
        // captured Babel candidates, but only Haste candidates or positive runtime evidence
        // can require coverage. A static transform alone never makes an untouched file covered.
        for (const filename of globalConfig.coverageProvider === 'babel' ? files : untestedFiles) {
          if (shouldInstrument(filename, globalConfig, config) && !this._coveredScripts.has(filename)) {
            const identity: string = coverageIdentity(context.config.rootDir, filename);
            const input: string | undefined = inputs[identity];
            if (input === undefined)
              throw new Error(`Failed to collect coverage from "${identity}": missing input.`);
            const rawMap: unknown = sourceMapFromInput(context.config.rootDir, filename, input, inputs);
            if (globalConfig.coverageProvider === 'babel') {
              if (
                this._collector.executionFiles.has(path.resolve(filename)) &&
                !untestedFiles.has(filename) &&
                !this._runtimeMappedScripts.has(filename)
              ) {
                // Actual output has already passed Istanbul's proof. An input-boundary call
                // alone is not evidence that the module body completed or owes counters.
                await this._observeSourceAsync(config, filename, input, rawMap);
                continue;
              }
              transformer ??= await createScriptTransformer(config);
              const transformed: TransformResult = await transformer.transformSourceAsync(filename, input, {
                instrument: true,
                supportsDynamicImport: true,
                supportsExportNamespaceFrom: true,
                supportsStaticESM: true,
                supportsTopLevelAwait: true
              });
              const initialCoverage: IBabelCoverageData | undefined = readInitialBabelCoverage(
                transformed.code,
                filename
              );
              if (transformed.sourceMapPath) {
                const instrumentationMap: unknown = await readCapturedSourceMapAsync(
                  transformed.sourceMapPath,
                  !initialCoverage
                );
                if (instrumentationMap) {
                  await captureCoverageSourceMapAsync(
                    context.config.rootDir,
                    filename,
                    instrumentationMap,
                    input,
                    this._collector.sources
                  );
                }
              } else if (config.transform.length && initialCoverage) {
                throw new Error(`Untested Babel coverage requires a verifiable source map: "${identity}".`);
              }
              if (initialCoverage) {
                await this._observeBabelCoverageAsync(
                  context.config,
                  filename,
                  input,
                  initialCoverage,
                  untestedFiles.has(filename) || this._runtimeMappedScripts.has(filename)
                );
              } else {
                // Ignored files have no counters or coverage obligation, but their captured
                // input and upstream originals must still pass the same source validation.
                await this._observeSourceAsync(context.config, filename, input, rawMap);
              }
              continue;
            }
            const sourceMap: IJestCoverageSourceMap | null = await this._observeSourceAsync(
              context.config,
              filename,
              input,
              rawMap
            );
            if (globalConfig.coverageProvider === 'v8') {
              addV8Coverage(this._collector.v8, {
                result: {
                  scriptId: '0',
                  url: identity,
                  functions: [
                    {
                      functionName: '(empty-report)',
                      isBlockCoverage: true,
                      ranges: [{ startOffset: 0, endOffset: Buffer.byteLength(input), count: 0 }]
                    }
                  ]
                },
                source: input,
                sourceMap,
                baseline: true
              });
            }
          }
        }
      }
    }
    this._collector.completed = true;
  }

  private async _observeBabelCoverageAsync(
    config: Config.ProjectConfig,
    filename: string,
    input: string,
    coverage: IBabelCoverageData,
    expectCoverage: boolean
  ): Promise<void> {
    const map: IJestCoverageSourceMap | null = await this._observeSourceAsync(
      config,
      filename,
      input,
      coverage.inputSourceMap
    );
    if (expectCoverage) {
      for (const identity of await expectedBabelCoverageFilesAsync(config.rootDir, filename, coverage, map)) {
        this._collector.expectedFiles.add(identity);
      }
    }
  }

  private _getInputsAsync(context: TestContext): Promise<IJestCoverageInputsSnapshot> {
    let inputs: Promise<IJestCoverageInputsSnapshot> | undefined = this._inputsByConfig.get(context.config);
    if (!inputs) {
      // Install the promise before awaiting so concurrent suite starts share the same immutable inputs.
      // Runtime transform/instrumentation provenance and final disk validation detect later mutations.
      const files: string[] = [];
      inputs = this._collector.inputsSnapshot
        ? Promise.resolve(this._collector.inputsSnapshot)
        : snapshotCoverageInputsAsync(
            originalCoverageConfig(context.config),
            this._globalConfig,
            context.hasteFS.getAbsoluteFileIterator(),
            files
          ).then((snapshot) =>
            Object.freeze({ inputs: Object.freeze(snapshot), files: Object.freeze(files) })
          );
      this._inputsByConfig.set(context.config, inputs);
    }
    return inputs;
  }

  private async _observeSourceAsync(
    config: Config.ProjectConfig,
    filename: string,
    input: string,
    rawMap: unknown
  ): Promise<IJestCoverageSourceMap | null> {
    const identity: string = coverageIdentity(config.rootDir, filename);
    await verifyCoverageSourceAsync(config.rootDir, identity, input, this._collector.sources);
    const map: IJestCoverageSourceMap | null = rawMap
      ? await captureCoverageSourceMapAsync(config.rootDir, filename, rawMap, input, this._collector.sources)
      : null;
    if (this._collector.configuration.provider === 'v8') {
      for (const original of map?.sources ?? [identity]) this._collector.expectedFiles.add(original);
    }
    return map;
  }
}
