// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { ScriptCov, FunctionCov, RangeCov } from '@bcoe/v8-coverage';
import type { Config } from '@jest/types';
import { defaults } from 'jest-config';
import { createCoverageMap, type CoverageMap, type FileCoverageData } from 'istanbul-lib-coverage';
import type v8ToIstanbul from 'v8-to-istanbul';
import { fromSource, mapFileCommentRegex } from 'convert-source-map';

import { JsonSchema } from '@rushstack/node-core-library';
import { validateShardPathAsync } from '@rushstack/heft/lib/sharding/ShardFileSystem';

import schema from './schemas/jest-coverage.schema.json';

export const SUPPORTED_COVERAGE_REPORTERS: ReadonlySet<string> = new Set([
  'json',
  'json-summary',
  'lcov',
  'lcovonly',
  'html',
  'clover',
  'cobertura',
  'text',
  'text-summary'
]);

export interface IJestCoverageConfiguration {
  enabled: boolean;
  provider: 'babel' | 'v8';
  collectCoverageFrom: string[];
  coveragePathIgnorePatterns: string[];
  // eslint-disable-next-line @rushstack/no-new-null -- Versioned JSON wire format.
  thresholds: Config.GlobalConfig['coverageThreshold'] | null;
  reporters: string[];
}

export interface IJestFileCoverageData extends FileCoverageData {
  /** Istanbul uses this marker to discard an untested-file baseline when real coverage exists. */
  all?: boolean;
}

/** Coverage is inline in the shard commit: an old sidecar can never stand in for a fresh collection. */
export interface IJestCoverage {
  version: 2;
  configuration: IJestCoverageConfiguration;
  // eslint-disable-next-line @rushstack/no-new-null -- Disabled coverage is explicit, never an omitted map.
  map: Record<string, IJestFileCoverageData> | null;
  sourceHashes: Record<string, string>;
  expectedFiles: string[];
  // eslint-disable-next-line @rushstack/no-new-null -- Provider-specific JSON data is explicit.
  v8: IJestV8Coverage[] | null;
}

export interface IJestCoverageSourceMap {
  version: 3;
  /** Build-root-relative original identities, materialized as absolute paths only for conversion. */
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
  /** The self-source's shebang was restored for hashing; conversion must use Jest's actual input text. */
  inputShebangRemoved?: true;
}

export interface IJestV8Coverage {
  result: ScriptCov;
  /** Unmapped scripts retain the full input, as Jest's public CoverageReporter supplies to its converter. */
  source: string;
  // eslint-disable-next-line @rushstack/no-new-null -- No implicit source-map/disk fallback on replay.
  sourceMap: IJestCoverageSourceMap | null;
  baseline: boolean;
}

const COVERAGE_SCHEMA: JsonSchema = JsonSchema.fromLoadedObject(schema);

/** Jest's ScriptTransformer removes the initial shebang, but preserves its newline. */
export function normalizeJestCoverageInput(source: string): string {
  return source.replace(/^#!.*/, '');
}

export function validateCoverageIdentity(identity: string): void {
  if (
    !identity ||
    path.posix.isAbsolute(identity) ||
    path.win32.isAbsolute(identity) ||
    identity.includes('\\') ||
    identity.includes(':') ||
    identity.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid build-root-relative coverage identity: "${identity}".`);
  }
}

export function coverageIdentity(buildFolderPath: string, filename: string): string {
  const identity: string = path.relative(buildFolderPath, filename).split(path.sep).join('/');
  validateCoverageIdentity(identity);
  return identity;
}

function validateThresholdGroup(name: string): void {
  if (name !== 'global' && name !== '.' && name !== './') {
    validateCoverageIdentity(name.replace(/^\.\//, '').replace(/\/$/, ''));
  }
}

export function createCoverageConfiguration(
  config: Config.InitialOptions,
  buildFolderPath: string
): IJestCoverageConfiguration {
  const portablePattern = (value: string): string => {
    const normalized: string = value.replaceAll(buildFolderPath, '<rootDir>').replaceAll('\\', '/');
    if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
      throw new Error('Managed Jest coverage configuration must not reference paths outside the build root.');
    }
    return normalized;
  };
  const thresholds: NonNullable<Config.GlobalConfig['coverageThreshold']> = Object.create(null);
  for (const [name, threshold] of Object.entries(config.coverageThreshold ?? {})) {
    const portableName: string = portablePattern(name);
    const key: string =
      portableName === '<rootDir>' || portableName === '<rootDir>/'
        ? '.'
        : portableName.replace(/^<rootDir>\//, '').replace(/^\.\//, '');
    validateThresholdGroup(key || '.');
    thresholds[key || '.'] = { ...threshold };
  }
  return {
    enabled: config.collectCoverage ?? false,
    provider: config.coverageProvider ?? defaults.coverageProvider,
    collectCoverageFrom: (config.collectCoverageFrom ?? []).map(portablePattern),
    coveragePathIgnorePatterns: (
      config.coveragePathIgnorePatterns ?? defaults.coveragePathIgnorePatterns
    ).map((pattern) => pattern.replaceAll(buildFolderPath, '<rootDir>')),
    thresholds: config.coverageThreshold === undefined ? null : thresholds,
    reporters: [...(config.coverageReporters ?? defaults.coverageReporters)] as string[]
  };
}

export function disabledJestCoverage(): IJestCoverage {
  return {
    version: 2,
    configuration: createCoverageConfiguration({}, process.cwd()),
    map: null,
    sourceHashes: Object.create(null),
    expectedFiles: [],
    v8: null
  };
}

/** Drop source-map caches and class instances after Jest has remapped the coverage. */
export function portableCoverageMap(
  map: CoverageMap,
  buildFolderPath: string,
  sources: ReadonlyMap<string, ICoverageSource>
): Record<string, IJestFileCoverageData> {
  const portable: Record<string, IJestFileCoverageData> = Object.create(null);
  for (const filename of Object.keys(map.toJSON()).sort()) {
    const identity: string = coverageIdentity(buildFolderPath, filename);
    const { statementMap, fnMap, branchMap, s, f, b, all } = map
      .fileCoverageFor(filename)
      .toJSON() as IJestFileCoverageData;
    const data: IJestFileCoverageData = structuredClone({
      path: identity,
      statementMap,
      fnMap,
      branchMap,
      s,
      f,
      b,
      ...(all === undefined ? {} : { all })
    });
    const source: ICoverageSource | undefined = sources.get(identity);
    if (!source) throw new Error(`Missing original coverage source "${identity}".`);
    const lines: string[] = source.text.split(/\r\n|\r|\n/);
    const normalizeEnd = (location: FileCoverageData['statementMap'][string]): void => {
      // Istanbul source-map remapping uses Infinity for an end-of-line without an exact
      // column mapping. JSON would turn it into null; resolve that sentinel, not the counters.
      if (location.end.column === Number.POSITIVE_INFINITY) {
        const line: string | undefined = lines[location.end.line - 1];
        if (line === undefined) throw new Error(`Invalid coverage source-map line for "${identity}".`);
        location.end.column = line.length;
      }
    };
    for (const location of Object.values(data.statementMap)) normalizeEnd(location);
    for (const fn of Object.values(data.fnMap)) {
      normalizeEnd(fn.loc);
      normalizeEnd(fn.decl);
    }
    for (const branch of Object.values(data.branchMap)) {
      normalizeEnd(branch.loc);
      for (const location of branch.locations) normalizeEnd(location);
    }
    portable[identity] = data;
  }
  // Normalize optional undefined location fields (e.g. Istanbul's implicit else arm) to JSON too.
  return JSON.parse(JSON.stringify(portable));
}

export interface ICoverageSource {
  hash: string;
  text: string;
}

export async function readCoverageSourceAsync(
  buildFolderPath: string,
  identity: string
): Promise<ICoverageSource> {
  validateCoverageIdentity(identity);
  const filename: string = path.resolve(buildFolderPath, identity);
  await validateShardPathAsync(buildFolderPath, filename);
  const contents: Buffer = await fs.readFile(filename);
  return { hash: createHash('sha256').update(contents).digest('hex'), text: contents.toString('utf8') };
}

function validateV8Ranges(entry: IJestV8Coverage): void {
  const sourceLength: number = (entry.sourceMap ? entry.source : normalizeJestCoverageInput(entry.source))
    .length;
  for (const fn of entry.result.functions) {
    const root: RangeCov | undefined = fn.ranges[0];
    if (!root) throw new Error('Missing raw V8 function-scoped coverage ranges.');
    let previousStart: number = -1;
    const parents: RangeCov[] = [];
    for (const range of fn.ranges) {
      if (
        !Number.isSafeInteger(range.count) ||
        range.count < 0 ||
        !Number.isSafeInteger(range.startOffset) ||
        range.startOffset < 0 ||
        !Number.isSafeInteger(range.endOffset) ||
        range.startOffset < root.startOffset ||
        range.endOffset > root.endOffset ||
        range.endOffset < range.startOffset ||
        range.startOffset < previousStart ||
        (!entry.baseline && range.endOffset > sourceLength)
      ) {
        throw new Error('Invalid raw V8 function-scoped coverage range.');
      }
      while (parents.length && range.startOffset >= parents[parents.length - 1].endOffset) parents.pop();
      if (parents.length && range.endOffset > parents[parents.length - 1].endOffset) {
        throw new Error('Crossing raw V8 coverage ranges.');
      }
      parents.push(range);
      previousStart = range.startOffset;
    }
  }
  const empty: FunctionCov | undefined = entry.result.functions[0];
  if (
    !empty ||
    (entry.baseline
      ? entry.result.functions.length !== 1 ||
        empty.functionName !== '(empty-report)' ||
        !empty.isBlockCoverage ||
        empty.ranges.length !== 1 ||
        empty.ranges[0].count !== 0 ||
        empty.ranges[0].startOffset !== 0 ||
        empty.ranges[0].endOffset !== Buffer.byteLength(entry.source)
      : entry.result.functions.some((fn) => fn.functionName === '(empty-report)'))
  ) {
    throw new Error('Invalid raw V8 untested-file baseline.');
  }
}

export function validateJestCoverage(value: unknown): IJestCoverage {
  COVERAGE_SCHEMA.validateObject(value, 'Jest shard coverage');
  const coverage: IJestCoverage = value as IJestCoverage;
  const { configuration, map, expectedFiles, sourceHashes, v8 } = coverage;
  if (
    configuration.enabled !== (map !== null) ||
    (!configuration.enabled && configuration.thresholds !== null)
  ) {
    throw new Error('Requested Jest coverage is missing or disabled despite required thresholds.');
  }
  if ((configuration.enabled && configuration.provider === 'v8') !== (v8 !== null)) {
    throw new Error('Missing or unexpected raw Jest V8 coverage.');
  }
  const rawSources: Map<string, string> = new Map();
  for (const entry of v8 ?? []) {
    validateCoverageIdentity(entry.result.url);
    if (!entry.sourceMap && (fromSource(entry.source) || mapFileCommentRegex.test(entry.source))) {
      throw new Error('Raw V8 coverage is missing its captured source map.');
    }
    const originals: string[] = entry.sourceMap?.sources ?? [entry.result.url];
    const contents: string[] = entry.sourceMap?.sourcesContent ?? [entry.source];
    if (originals.length !== contents.length) throw new Error('Inconsistent V8 original sources.');
    if (entry.sourceMap?.inputShebangRemoved) {
      let selfSources: number = 0;
      let selfContent: string | undefined;
      for (const [index, identity] of originals.entries()) {
        if (identity === entry.result.url) {
          selfSources++;
          selfContent = contents[index];
        }
      }
      if (selfSources !== 1 || !selfContent?.startsWith('#!')) {
        throw new Error('Invalid captured V8 input shebang normalization.');
      }
    }
    for (const [index, identity] of originals.entries()) {
      validateCoverageIdentity(identity);
      const text: string = contents[index];
      if (
        (rawSources.has(identity) && rawSources.get(identity) !== text) ||
        sourceHashes[identity] !== createHash('sha256').update(text).digest('hex')
      ) {
        throw new Error(`Inconsistent captured V8 coverage source "${identity}".`);
      }
      rawSources.set(identity, text);
    }
    validateV8Ranges(entry);
  }
  if (v8 !== null && rawSources.size !== Object.keys(sourceHashes).length) {
    throw new Error('Missing raw V8 coverage for an original source.');
  }
  if (configuration.reporters.some((reporter) => !SUPPORTED_COVERAGE_REPORTERS.has(reporter))) {
    throw new Error('Unsupported managed Jest coverage reporter.');
  }
  for (const name of Object.keys(configuration.thresholds ?? {})) {
    validateThresholdGroup(name);
  }
  const files: Set<string> = new Set(Object.keys(map ?? {}));
  if (files.size !== Object.keys(sourceHashes).length || (!configuration.enabled && expectedFiles.length)) {
    throw new Error('Inconsistent Jest coverage file identities or source hashes.');
  }
  for (const identity of expectedFiles) {
    validateCoverageIdentity(identity);
    if (!files.has(identity)) throw new Error(`Missing coverage map for required source "${identity}".`);
  }
  for (const [identity, file] of Object.entries(map ?? {})) {
    validateCoverageIdentity(identity);
    if (file.path !== identity || !Object.hasOwn(sourceHashes, identity)) {
      throw new Error(`Inconsistent Jest coverage file identity: "${identity}".`);
    }
    for (const [counters, locations] of [
      [file.s, file.statementMap],
      [file.f, file.fnMap],
      [file.b, file.branchMap]
    ]) {
      const keys: string[] = Object.keys(counters);
      if (
        keys.length !== Object.keys(locations).length ||
        keys.some((key) => !Object.hasOwn(locations, key))
      ) {
        throw new Error(`Inconsistent Jest coverage counter identities for "${identity}".`);
      }
    }
    for (const [key, counts] of Object.entries(file.b)) {
      if (counts.length !== file.branchMap[key].locations.length) {
        throw new Error(`Inconsistent Jest branch coverage counters for "${identity}".`);
      }
    }
    if (
      file.all &&
      configuration.provider !== 'v8' &&
      (Object.values(file.s).some((count) => count !== 0) ||
        Object.values(file.f).some((count) => count !== 0) ||
        Object.values(file.b).some((counts) => counts.some((count) => count !== 0)))
    ) {
      throw new Error(`Invalid nonzero untested-file coverage baseline for "${identity}".`);
    }
    const checkLocation = (location: FileCoverageData['statementMap'][string]): void => {
      if (
        location.end.line < location.start.line ||
        (location.end.line === location.start.line && location.end.column < location.start.column) ||
        (configuration.provider !== 'v8' && (location.start.column < 0 || location.end.column < 0))
      ) {
        throw new Error(`Invalid Jest coverage location for "${identity}".`);
      }
    };
    for (const location of Object.values(file.statementMap)) checkLocation(location);
    for (const fn of Object.values(file.fnMap)) {
      checkLocation(fn.loc);
      checkLocation(fn.decl);
    }
    for (const branch of Object.values(file.branchMap)) {
      checkLocation(branch.loc);
      for (const [index, location] of branch.locations.entries()) {
        // Istanbul's implicit "else" arm has no source location, but it still has a hit counter.
        if (location.start.line === undefined) {
          if (branch.type !== 'if' || index !== 1 || branch.locations.length !== 2) {
            throw new Error(`Invalid empty Jest branch location for "${identity}".`);
          }
        } else {
          checkLocation(location);
        }
      }
    }
  }
  return coverage;
}

/** Retain one source/map and function-scoped range tree per script, not one copy per suite. */
export function addV8Coverage(scripts: Map<string, IJestV8Coverage>, entry: IJestV8Coverage): void {
  // Validate before normalization/supersession: merging must never erase malformed observations.
  validateV8Ranges(entry);
  const previous: IJestV8Coverage | undefined = scripts.get(entry.result.url);
  if (previous && previous.baseline !== entry.baseline) {
    // Untested code has not been transformed; its baseline must not constrain executed code.
    if (entry.baseline) return;
  } else if (previous) {
    if (previous.source !== entry.source || !isDeepStrictEqual(previous.sourceMap, entry.sourceMap)) {
      throw new Error(`Incompatible V8 code or source maps across shards: "${entry.result.url}".`);
    }
    if (entry.baseline) return;
    const { mergeScriptCovs }: typeof import('@bcoe/v8-coverage') = require('@bcoe/v8-coverage');
    const merged: IJestV8Coverage = {
      ...previous,
      result: mergeScriptCovs([structuredClone(previous.result), structuredClone(entry.result)])!
    };
    validateV8Ranges(merged);
    scripts.set(entry.result.url, merged);
    return;
  }
  scripts.set(entry.result.url, { ...entry, result: structuredClone(entry.result) });
}

/** Merge function-scoped V8 ranges before converting, exactly as Jest's public CoverageReporter does. */
export async function convertV8CoverageAsync(
  entries: Iterable<IJestV8Coverage>
): Promise<Record<string, IJestFileCoverageData>> {
  const byScript: Map<string, IJestV8Coverage> = new Map();
  const originals: Map<string, ICoverageSource> = new Map();
  for (const entry of entries) addV8Coverage(byScript, entry);
  for (const entry of byScript.values()) {
    const identities: string[] = entry.sourceMap?.sources ?? [entry.result.url];
    const contents: string[] = entry.sourceMap?.sourcesContent ?? [entry.source];
    for (const [index, identity] of identities.entries()) {
      const text: string = contents[index];
      const previous: ICoverageSource | undefined = originals.get(identity);
      if (previous && previous.text !== text) throw new Error(`Conflicting V8 source "${identity}".`);
      originals.set(identity, { text, hash: createHash('sha256').update(text).digest('hex') });
    }
  }
  const { default: createConverter } = await import('v8-to-istanbul');
  const { mergeScriptCovs } = await import('@bcoe/v8-coverage');
  const merged: CoverageMap = createCoverageMap({});
  const root: string = process.cwd();
  for (const url of [...byScript.keys()].sort()) {
    const entry: IJestV8Coverage = byScript.get(url)!;
    const script: ScriptCov = mergeScriptCovs([structuredClone(entry.result)])!;
    const sourceMap: IJestCoverageSourceMap | null = entry.sourceMap
      ? {
          ...entry.sourceMap,
          sourcesContent: entry.sourceMap.inputShebangRemoved
            ? entry.sourceMap.sourcesContent.map((text, index) =>
                entry.sourceMap!.sources[index] === url ? normalizeJestCoverageInput(text) : text
              )
            : entry.sourceMap.sourcesContent
        }
      : null;
    // The converter trims trailing whitespace. A newline avoids its disk fallback for an empty input.
    const source: string = entry.source || '\n';
    const converter: ReturnType<typeof v8ToIstanbul> = createConverter(
      path.resolve(root, script.url),
      0,
      sourceMap
        ? {
            source,
            originalSource: sourceMap.sourcesContent[0],
            sourceMap: {
              sourcemap: {
                ...sourceMap,
                sources: sourceMap.sources.map((identity) => path.resolve(root, identity))
              }
            }
          }
        : { source }
    );
    try {
      await converter.load();
      converter.applyCoverage(script.functions);
      merged.merge(converter.toIstanbul());
    } finally {
      converter.destroy();
    }
  }
  return portableCoverageMap(merged, root, originals);
}

export async function mergeJestCoverage(contributions: Iterable<IJestCoverage>): Promise<IJestCoverage> {
  let configuration: IJestCoverageConfiguration | undefined;
  let configurationKey: string | undefined;
  const merged: CoverageMap = createCoverageMap({});
  const sourceHashes: Record<string, string> = Object.create(null);
  const expectedFiles: Set<string> = new Set();
  const babelShapes: Map<string, string> = new Map();
  const statementShapes: Map<string, string> = new Map();
  const v8: Map<string, IJestV8Coverage> = new Map();
  for (const value of contributions) {
    const contribution: IJestCoverage = validateJestCoverage(value);
    const key: string = JSON.stringify(contribution.configuration);
    if (configurationKey !== undefined && configurationKey !== key) {
      throw new Error('Incompatible Jest coverage configuration across shards.');
    }
    configurationKey = key;
    configuration = contribution.configuration;
    if (contribution.v8 !== null) {
      const converted: Record<string, IJestFileCoverageData> = await convertV8CoverageAsync(contribution.v8);
      if (!isDeepStrictEqual(converted, contribution.map)) {
        throw new Error('Jest V8 coverage map does not match its raw function-scoped coverage.');
      }
      for (const entry of contribution.v8) addV8Coverage(v8, entry);
    }
    for (const [identity, hash] of Object.entries(contribution.sourceHashes)) {
      if (Object.hasOwn(sourceHashes, identity) && sourceHashes[identity] !== hash) {
        throw new Error(`Incompatible Jest coverage sources across shards: "${identity}".`);
      }
      sourceHashes[identity] = hash;
      if (!contribution.map![identity].all) {
        const shape: string = JSON.stringify(contribution.map![identity].statementMap);
        const previous: string | undefined = statementShapes.get(identity);
        if (previous !== undefined && previous !== shape) {
          throw new Error(`Incompatible coverage statement maps across shards: "${identity}".`);
        }
        statementShapes.set(identity, shape);
      }
      if (configuration.provider === 'babel' && !contribution.map![identity].all) {
        const { statementMap, fnMap, branchMap } = contribution.map![identity];
        const shape: string = JSON.stringify({ statementMap, fnMap, branchMap });
        const previous: string | undefined = babelShapes.get(identity);
        if (previous !== undefined && previous !== shape) {
          throw new Error(`Incompatible Babel coverage maps across shards: "${identity}".`);
        }
        babelShapes.set(identity, shape);
      }
    }
    for (const identity of contribution.expectedFiles) expectedFiles.add(identity);
    if (contribution.map && contribution.v8 === null) merged.merge(contribution.map);
  }
  if (!configuration) throw new Error('No Jest coverage contributions.');
  const selectedV8: IJestV8Coverage[] | null =
    configuration.enabled && configuration.provider === 'v8' ? [...v8.values()] : null;
  // toJSON() returns FileCoverage objects; JSON round-tripping invokes their public toJSON too.
  const map: Record<string, IJestFileCoverageData> | null = configuration.enabled
    ? configuration.provider === 'v8'
      ? await convertV8CoverageAsync(selectedV8!)
      : JSON.parse(JSON.stringify(merged.toJSON()))
    : null;
  const effectiveHashes: Record<string, string> = Object.create(null);
  for (const identity of Object.keys(map ?? {})) effectiveHashes[identity] = sourceHashes[identity];
  return validateJestCoverage({
    version: 2,
    configuration,
    map,
    sourceHashes: effectiveHashes,
    expectedFiles: selectedV8 ? Object.keys(map!).sort() : [...expectedFiles].sort(),
    v8: selectedV8
  });
}
