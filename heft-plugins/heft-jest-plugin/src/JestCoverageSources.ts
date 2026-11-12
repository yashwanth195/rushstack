// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TraceMap, type EncodedSourceMap } from '@jridgewell/trace-mapping';
import { fromSource, fromMapFileSource } from 'convert-source-map';
import type { Config } from '@jest/types';
import { createScriptTransformer, shouldInstrument, type ScriptTransformer } from '@jest/transform';
import { createCoverageMap, type CoverageMap, type FileCoverageData } from 'istanbul-lib-coverage';
import type { MapStore } from 'istanbul-lib-source-maps';
import type { Instrumenter } from 'istanbul-lib-instrument';

import {
  coverageIdentity,
  normalizeJestCoverageInput,
  readCoverageSourceAsync,
  type ICoverageSource,
  type IJestCoverageSourceMap
} from './JestCoverage';

async function* coverageInputFilesAsync(
  config: Config.ProjectConfig,
  hasteFiles: Iterable<string>
): AsyncIterable<string> {
  const discovered: Set<string> = new Set(hasteFiles);
  yield* discovered;
  const extensions: Set<string> = new Set(config.moduleFileExtensions);
  const transformPatterns: RegExp[] = config.transform.map(([pattern]) => new RegExp(pattern));
  const transformer: ScriptTransformer | undefined = transformPatterns.length
    ? await createScriptTransformer(config)
    : undefined;
  const folders: string[] = [config.rootDir];
  while (folders.length) {
    const folder: string = folders.pop()!;
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      // Never crawl dependency trees, repository metadata, or directory aliases.
      // Coverage identities still go through the existing captured-source/path validation.
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.hg') continue;
      const filename: string = path.join(folder, entry.name);
      if (entry.isDirectory()) folders.push(filename);
      else if (
        entry.isFile() &&
        !discovered.has(filename) &&
        // Match Haste's module extensions or a configured runtime transform. shouldTransform
        // only checks transform availability/ignores, not whether a transform matches this path.
        (extensions.has(path.extname(filename).slice(1)) ||
          (transformer?.shouldTransform(filename) &&
            transformPatterns.some((pattern) => pattern.test(filename))))
      ) {
        yield filename;
      }
    }
  }
}

/**
 * Taken once per project by the first public onTestFileStart, before Jest loads setup/test modules.
 * Do not substitute a post-test disk read for these inputs. No Jest private transform/runtime fields are accessed.
 */
export async function snapshotCoverageInputsAsync(
  config: Config.ProjectConfig,
  globalConfig: Config.GlobalConfig,
  files: Iterable<string>,
  coverageFiles?: string[]
): Promise<Record<string, string>> {
  const inputs: Record<string, string> = Object.create(null);
  for await (const filename of coverageInputFilesAsync(config, files)) {
    if (!shouldInstrument(filename, globalConfig, config)) continue;
    // Keep executable candidates separate from captured external source-map documents.
    coverageFiles?.push(filename);
    const identity: string = coverageIdentity(config.rootDir, filename);
    let source: string;
    try {
      source = (await readCoverageSourceAsync(config.rootDir, identity)).text;
    } catch (error) {
      throw new Error(`Failed to collect coverage from "${identity}": missing source input.`, {
        cause: error
      });
    }
    inputs[identity] = source;
    if (!fromSource(source)) {
      await fromMapFileSource(source, async (mapFile) => {
        const mapIdentity: string = coverageIdentity(
          config.rootDir,
          path.resolve(path.dirname(filename), mapFile)
        );
        const captured: string = (await readCoverageSourceAsync(config.rootDir, mapIdentity)).text;
        inputs[mapIdentity] = captured;
        return captured;
      });
    }
  }
  return inputs;
}

export function sourceMapFromInput(
  buildFolderPath: string,
  filename: string,
  source: string,
  inputs: Readonly<Record<string, string>>
): unknown {
  return (
    fromSource(source) ??
    fromMapFileSource(source, (mapFile) => {
      const identity: string = coverageIdentity(
        buildFolderPath,
        path.resolve(path.dirname(filename), mapFile)
      );
      const captured: string | undefined = inputs[identity];
      if (captured === undefined) throw new Error(`Missing captured Jest source map "${identity}".`);
      return captured;
    })
  )?.toObject();
}

export async function readCapturedSourceMapAsync(
  filename: string,
  allowMissing: boolean = false
): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Missing coverage map or invalid transformer source map: "${filename}".`, {
      cause: error
    });
  }
}

export interface IBabelCoverageData extends FileCoverageData {
  inputSourceMap?: unknown;
}

interface IInitialBabelCoverage {
  coverageData: IBabelCoverageData;
}

/** Require instrumentation unless Istanbul itself proves this executable text has a file exclusion. */
export function readInitialBabelCoverage(code: string, filename: string): IBabelCoverageData | undefined {
  const {
    createInstrumenter,
    readInitialCoverage
  }: typeof import('istanbul-lib-instrument') = require('istanbul-lib-instrument');
  // The library returns null for absent instrumentation, despite its older declaration's return type.
  const initial: IInitialBabelCoverage | undefined = readInitialCoverage(code) || undefined;
  if (!initial) {
    const instrumenter: Instrumenter = createInstrumenter({ esModules: true, autoWrap: true });
    const instrumented: string = instrumenter.instrumentSync(code, filename);
    const coverage: FileCoverageData | undefined = instrumenter.lastFileCoverage();
    // An empty program still gets instrumentation. An already-instrumented binding without
    // readable coverage does not produce fileCoverage. Only a real ignore-file comment gives
    // us both an empty visitor result and no instrumentation, unlike directive-like strings.
    if (
      coverage?.path === filename &&
      Object.keys(coverage.statementMap).length === 0 &&
      Object.keys(coverage.fnMap).length === 0 &&
      Object.keys(coverage.branchMap).length === 0 &&
      !readInitialCoverage(instrumented)
    ) {
      return undefined;
    }
    throw new Error(`Missing coverage map: Babel instrumentation was not produced for "${filename}".`);
  }
  if (initial.coverageData.path !== filename) {
    throw new Error(`Inconsistent Babel instrumentation source identity: "${filename}".`);
  }
  return initial.coverageData;
}

/** Derive completeness from actual instrumentation independently of Jest's final aggregated map. */
export async function expectedBabelCoverageFilesAsync(
  buildFolderPath: string,
  filename: string,
  coverage: IBabelCoverageData,
  // eslint-disable-next-line @rushstack/no-new-null -- Matches the versioned coverage source-map representation.
  sourceMap: IJestCoverageSourceMap | null
): Promise<Set<string>> {
  if (coverage.path !== filename) {
    throw new Error(`Inconsistent Babel instrumentation source identity: "${filename}".`);
  }
  if (!sourceMap) return new Set([coverageIdentity(buildFolderPath, filename)]);
  const {
    createSourceMapStore
  }: typeof import('istanbul-lib-source-maps') = require('istanbul-lib-source-maps');
  const store: MapStore = createSourceMapStore();
  // Do not let unverified inputSourceMap/cache properties override the registered, captured map.
  const { statementMap, fnMap, branchMap, s, f, b } = coverage;
  const raw: CoverageMap = createCoverageMap({
    [filename]: structuredClone({ path: filename, statementMap, fnMap, branchMap, s, f, b })
  });
  try {
    store.registerMap(filename, {
      ...sourceMap,
      // The older source-map declaration incorrectly types the standard numeric version as a string.
      version: sourceMap.version as unknown as string,
      file: filename,
      sources: sourceMap.sources.map((identity) => path.resolve(buildFolderPath, identity))
    });
    const remapped: CoverageMap = await store.transformCoverage(raw);
    return new Set(remapped.files().map((file) => coverageIdentity(buildFolderPath, file)));
  } finally {
    store.dispose();
  }
}

export async function verifyCoverageSourceAsync(
  buildFolderPath: string,
  identity: string,
  text: string,
  observed: Map<string, ICoverageSource>
): Promise<void> {
  const previous: ICoverageSource | undefined = observed.get(identity);
  if (previous && previous.text !== text) {
    throw new Error(`Conflicting captured Jest coverage sources across suites: "${identity}".`);
  }
  let disk: ICoverageSource;
  try {
    disk = await readCoverageSourceAsync(buildFolderPath, identity);
  } catch (error) {
    throw new Error(`Failed to collect coverage from "${identity}": cannot verify captured source.`, {
      cause: error
    });
  }
  if (disk.text !== text) {
    throw new Error(`Captured Jest coverage source does not match disk: "${identity}".`);
  }
  observed.set(identity, disk);
}

/**
 * Accept only local, complete original sources. A missing sourcesContent entry is provable only
 * for the transform's own input, not by reading an arbitrary original file after execution.
 * Runtime instrumentation maps require their actual sourcesContent, never a snapshot fallback.
 */
export async function captureCoverageSourceMapAsync(
  buildFolderPath: string,
  filename: string,
  raw: unknown,
  originalCode: string | undefined,
  observed: Map<string, ICoverageSource>,
  requireSourcesContent: boolean = false
): Promise<IJestCoverageSourceMap> {
  const map: EncodedSourceMap = raw as EncodedSourceMap;
  if (
    !map ||
    map.version !== 3 ||
    !Array.isArray(map.sources) ||
    !map.sources.length ||
    map.sources.some((source) => typeof source !== 'string') ||
    !Array.isArray(map.names) ||
    map.names.some((name) => typeof name !== 'string') ||
    typeof map.mappings !== 'string' ||
    'sections' in map ||
    (map.sourcesContent !== undefined &&
      (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length))
  ) {
    throw new Error(`Unsupported or unverifiable Jest source map for "${filename}".`);
  }
  // TraceMap resolves URLs, not native Windows paths. Convert absolute filesystem paths first.
  const trace: TraceMap = new TraceMap(
    {
      ...map,
      sourceRoot:
        map.sourceRoot && path.isAbsolute(map.sourceRoot)
          ? pathToFileURL(`${map.sourceRoot}${path.sep}`).href
          : map.sourceRoot?.replaceAll('\\', '/'),
      sources: map.sources.map((source) =>
        path.isAbsolute(source!) ? pathToFileURL(source!).href : source!.replaceAll('\\', '/')
      )
    },
    pathToFileURL(filename).href
  );
  const sources: string[] = [];
  const sourcesContent: string[] = [];
  let inputShebangRemoved: boolean = false;
  let inputSourceCount: number = 0;
  const inputIdentity: string = coverageIdentity(buildFolderPath, filename);
  for (const [index, resolved] of trace.resolvedSources.entries()) {
    if (!resolved || !resolved.startsWith('file:')) {
      throw new Error(`Managed Jest coverage requires local source-map sources: "${resolved}".`);
    }
    const identity: string = coverageIdentity(buildFolderPath, fileURLToPath(resolved));
    if (identity === inputIdentity) inputSourceCount++;
    let text: unknown =
      map.sourcesContent?.[index] ??
      (!requireSourcesContent && map.sources.length === 1 && identity === inputIdentity
        ? originalCode
        : undefined);
    if (
      identity === inputIdentity &&
      originalCode !== undefined &&
      text !== originalCode &&
      text === normalizeJestCoverageInput(originalCode)
    ) {
      inputShebangRemoved = true;
      text = originalCode;
    }
    if (typeof text !== 'string') {
      throw new Error(`Missing trustworthy sourcesContent for Jest coverage source "${identity}".`);
    }
    if (
      requireSourcesContent &&
      identity === inputIdentity &&
      originalCode !== undefined &&
      text !== originalCode
    ) {
      throw new Error(`Executed Jest coverage input differs from its snapshot: "${identity}".`);
    }
    await verifyCoverageSourceAsync(buildFolderPath, identity, text, observed);
    sources.push(identity);
    sourcesContent.push(text);
  }
  if (inputShebangRemoved && inputSourceCount !== 1) {
    throw new Error(`Ambiguous Jest input shebang normalization for "${filename}".`);
  }
  return {
    version: 3,
    sources,
    sourcesContent,
    names: [...map.names],
    mappings: map.mappings,
    ...(inputShebangRemoved ? { inputShebangRemoved: true } : {})
  };
}
