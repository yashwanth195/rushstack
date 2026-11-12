// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Config } from '@jest/types';
import {
  createScriptTransformer,
  createTranspilingRequire,
  shouldInstrument,
  type AsyncTransformer,
  type ScriptTransformer,
  type Transformer,
  type TransformerFactory,
  type TransformOptions,
  type TransformResult,
  type TransformedSource
} from '@jest/transform';

import { recordExecutionInput } from './JestCoverageEvidence';

export interface IJestCoverageTransformerOptions extends Record<string, unknown> {
  originalConfig: Config.ProjectConfig;
  coverageOptions: Pick<Config.GlobalConfig, 'collectCoverage' | 'collectCoverageFrom' | 'coverageProvider'>;
  attempt: string;
}

interface IDelegatingTransformerOptions {
  originalPath: string;
  originalTransformerConfig: unknown;
  getTransformer: () => Transformer;
}

export function originalCoverageConfig(config: Config.ProjectConfig): Config.ProjectConfig {
  const entry: Config.ProjectConfig['transform'][number] | undefined = config.transform[0];
  return entry && path.normalize(entry[1]) === require.resolve('./JestCoverageTransformer')
    ? (entry[2] as IJestCoverageTransformerOptions).originalConfig
    : config;
}

/**
 * The outer transformer witnesses inputs and outputs, including disk-cache hits. Public factory
 * adapters forward the actual runtime options to user code; Jest still owns the transform cache,
 * instrumentation, source maps and checksum validation. No runtime cacheFS is copied or emulated.
 */
export async function createTransformer(
  settings: IJestCoverageTransformerOptions | IDelegatingTransformerOptions
): Promise<Transformer> {
  // Only the in-process cache adapter supplies this callback; it is never serialized into Jest config.
  if (typeof settings.getTransformer === 'function') return settings.getTransformer();
  if (!('originalConfig' in settings))
    throw new Error('Missing original managed Jest transform configuration.');
  const { originalConfig, coverageOptions, attempt } = settings;
  if (
    originalConfig.transform.some(
      ([, module]) => path.normalize(module) === require.resolve('./JestCoverageTransformer')
    )
  ) {
    throw new Error('Recursive managed Jest coverage transformer.');
  }

  const requests: AsyncLocalStorage<TransformOptions> = new AsyncLocalStorage();
  const loadModule: Awaited<ReturnType<typeof createTranspilingRequire>> = await createTranspilingRequire({
    ...originalConfig,
    transform: []
  });
  const transform: Config.ProjectConfig['transform'] = await Promise.all(
    originalConfig.transform.map(async ([pattern, originalPath, transformerConfig]) => {
      let upstream: Transformer | TransformerFactory<Transformer> = await loadModule(originalPath, true);
      if (upstream && 'createTransformer' in upstream && typeof upstream.createTransformer === 'function') {
        upstream = await upstream.createTransformer(transformerConfig);
      }
      if (!upstream || !('process' in upstream || 'processAsync' in upstream)) {
        throw new TypeError(
          `Invalid transformer module "${originalPath}": expected process or processAsync.`
        );
      }
      const adapter: Transformer = delegateTransformer(upstream, transformerConfig, requests);
      const adapterOptions: IDelegatingTransformerOptions = {
        originalPath,
        originalTransformerConfig: transformerConfig,
        getTransformer: () => adapter
      };
      return [pattern, require.resolve('./JestCoverageTransformer'), { ...adapterOptions }];
    })
  );
  // Prepare all asynchronous factories before Jest can request a synchronous require transform.
  // The inner ScriptTransformer's Map is not used by user code: adapters supply the real runtime Map.
  const delegate: ScriptTransformer = await createScriptTransformer({ ...originalConfig, transform });
  const outputsByRuntime: WeakMap<Map<string, string>, Map<string, TransformedSource>> = new WeakMap();
  let configString: string | undefined;

  function originalOptions(options: TransformOptions): TransformOptions {
    if (configString === undefined) {
      // Jest already stable-stringified the embedded original config. Preserve that exact key
      // ordering instead of introducing another stable-JSON implementation or dependency.
      const sortedConfig: Config.ProjectConfig = JSON.parse(options.configString);
      configString = JSON.stringify(originalCoverageConfig(sortedConfig));
    }
    return { ...options, config: originalConfig, configString };
  }

  function requestKey(source: string, filename: string, options: TransformOptions): string {
    return createHash('sha256')
      .update(source)
      .update(
        JSON.stringify([
          filename,
          options.instrument,
          options.supportsDynamicImport,
          options.supportsExportNamespaceFrom,
          options.supportsStaticESM,
          options.supportsTopLevelAwait
        ])
      )
      .digest('hex');
  }

  function observe(source: string, filename: string, options: TransformOptions): boolean {
    const eligible: boolean = shouldInstrument(filename, coverageOptions, originalConfig);
    if (eligible)
      recordExecutionInput(originalConfig, attempt, { filename, source, instrument: options.instrument });
    return eligible;
  }

  function finish(
    source: string,
    filename: string,
    options: TransformOptions,
    eligible: boolean,
    result: TransformResult
  ): string {
    let map: TransformedSource['map'];
    if (result.sourceMapPath) {
      try {
        map = fs.readFileSync(result.sourceMapPath, 'utf8');
      } catch (error) {
        // Jest 30 returns a hypothetical ".map" path on disk-cache hits even for mapless
        // transforms. Do not invent a map; the collector still requires maps for counters.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const output: TransformedSource = { code: result.code, map };
    if (eligible) {
      recordExecutionInput(originalConfig, attempt, {
        filename,
        source,
        code: result.code,
        instrument: options.instrument
      });
    }
    // Jest's inner cache has already applied the upstream key and cache:false policy. Address the
    // outer cache by that verified output; do not implement another disk cache for evidence.
    const key: string = createHash('sha256')
      .update(JSON.stringify([filename, output]))
      .digest('hex');
    let outputs: Map<string, TransformedSource> | undefined = outputsByRuntime.get(options.cacheFS);
    if (!outputs) {
      outputs = new Map();
      outputsByRuntime.set(options.cacheFS, outputs);
    }
    outputs.set(requestKey(source, filename, options), output);
    return key;
  }

  function getOutput(source: string, filename: string, options: TransformOptions): TransformedSource {
    const key: string = requestKey(source, filename, options);
    const outputs: Map<string, TransformedSource> | undefined = outputsByRuntime.get(options.cacheFS);
    const result: TransformedSource | undefined = outputs?.get(key);
    if (!result) throw new Error(`Missing canonical Jest transform result for "${filename}".`);
    // Identical async requests can have overlapping consumers, and cache hits never call process.
    // Retain one output per input/options pair; the owning runtime Map's lifetime bounds retention.
    return result;
  }

  return {
    // The delegate has already applied exactly the instrumentation Jest would apply.
    canInstrument: true,
    getCacheKey(source: string, filename: string, options: TransformOptions): string {
      const eligible: boolean = observe(source, filename, options);
      const result: TransformResult =
        options.instrument || delegate.shouldTransform(filename)
          ? requests.run(originalOptions(options), () => delegate.transformSource(filename, source, options))
          : { code: source, originalCode: source, sourceMapPath: null };
      return finish(source, filename, options, eligible, result);
    },
    async getCacheKeyAsync(source: string, filename: string, options: TransformOptions): Promise<string> {
      const eligible: boolean = observe(source, filename, options);
      const result: TransformResult =
        options.instrument || delegate.shouldTransform(filename)
          ? await requests.run(originalOptions(options), () =>
              delegate.transformSourceAsync(filename, source, options)
            )
          : { code: source, originalCode: source, sourceMapPath: null };
      return finish(source, filename, options, eligible, result);
    },
    process: (source, filename, options) => getOutput(source, filename, options),
    processAsync: async (source, filename, options) => getOutput(source, filename, options)
  };
}

function delegateTransformer(
  upstream: Transformer,
  transformerConfig: unknown,
  requests: AsyncLocalStorage<TransformOptions>
): Transformer {
  if (typeof upstream.process !== 'function' && typeof upstream.processAsync !== 'function') {
    throw new TypeError('Invalid transformer: expected process or processAsync.');
  }
  function options(): TransformOptions {
    const request: TransformOptions | undefined = requests.getStore();
    if (!request) throw new Error('Missing managed Jest transform request.');
    return { ...request, transformerConfig: transformerConfig ?? {} };
  }
  const getCacheKeyAsync: Transformer['getCacheKeyAsync'] | Transformer['getCacheKey'] =
    upstream.getCacheKeyAsync ?? upstream.getCacheKey;
  const processAsync: NonNullable<Transformer['processAsync']> | NonNullable<Transformer['process']> =
    (upstream.processAsync ?? upstream.process)!;
  const adapter: AsyncTransformer = {
    canInstrument: upstream.canInstrument,
    getCacheKey: upstream.getCacheKey
      ? (source, filename) => upstream.getCacheKey!(source, filename, options())
      : undefined,
    getCacheKeyAsync: getCacheKeyAsync
      ? async (source, filename) => await getCacheKeyAsync(source, filename, options())
      : undefined,
    // Keep sync-only method availability and Jest's receiver semantics: sync calls are bound,
    // whereas Jest invokes the selected async/fallback function without a receiver.
    process: upstream.process
      ? (source, filename) => upstream.process!(source, filename, options())
      : undefined,
    processAsync: async (source, filename) => await processAsync(source, filename, options())
  };
  return adapter;
}

export default { createTransformer };
