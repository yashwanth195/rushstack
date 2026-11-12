// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { _IRushProjectJson } from '@microsoft/rush-lib';
import type { IBuildXLRushGraph } from '@rushstack/rush-buildxl-graph-plugin';
import { createCoverageMap, type CoverageMapData } from 'istanbul-lib-coverage';
import { RushHeftFixture, type ICliResult, type IManagedGroup, type JestManifest } from './RushHeftFixture';

const fixture: RushHeftFixture = new RushHeftFixture();

interface IFixtureCoverageSelection {
  collectCoverageFrom: string[];
}

interface IFixtureCommandConfiguration {
  commands: { incremental: boolean }[];
}

function expectMatrixGroup(
  group: IManagedGroup,
  count: number,
  runs: number,
  collations: number,
  success: boolean
): void {
  const report = fixture.report(group);
  const manifests: JestManifest[] = fixture.manifests(count, group);
  expect(report.success).toBe(success);
  expect(report.shardCount).toBe(count);
  expect(report.testFiles).toHaveLength(2);
  expect(manifests.map((manifest) => manifest.shardIndex)).toEqual(
    Array.from({ length: count }, (unused, index) => index + 1)
  );
  expect(manifests.flatMap((manifest) => manifest.payload.testFiles.map((file) => file.path)).sort()).toEqual(
    [`tests/${group.phaseName}/1.test.js`, `tests/${group.phaseName}/2.test.js`]
  );
  for (const manifest of manifests) {
    expect(manifest.status).toBe('completed');
    expect(manifest.generation).toBe(report.generation);
    expect(manifest.shardCount).toBe(count);
  }
  const coverage = fixture.read<CoverageMapData>(
    `${group.outputFolder}/jest-collated-coverage/coverage-final.json`,
    group
  );
  expect(Object.keys(coverage)).toEqual(['source.js']);
  expect(createCoverageMap(coverage).getCoverageSummary().branches.pct).toBe(100);
  expect(
    fs.readFileSync(
      path.join(group.projectFolder, group.outputFolder, 'jest-collated-coverage', 'lcov.info'),
      'utf8'
    )
  ).toContain('SF:source.js');
  expect(fs.existsSync(path.join(group.projectFolder, group.downstreamFolder, 'jest-collated.json'))).toBe(
    success
  );
  expect(fixture.suiteRuns(group)).toHaveLength(runs);
  expect(fixture.observations(`${group.phaseName}-prepare`, group)).toHaveLength(collations);
  const observations = fixture.observations(`${group.phaseName}-collate`, group);
  expect(observations).toHaveLength(collations);
  expect(observations.at(-1)?.generation).toBe(report.generation);
}

function expectExit(result: ICliResult, code: number): void {
  if (result.code !== code)
    throw new Error(`Expected exit ${code}, received ${result.code}:\n${result.output}`);
}

function expectComplete(count: number, files: number, success: boolean): JestManifest[] {
  const manifests: JestManifest[] = fixture.manifests(count);
  const report = fixture.report();
  expect(report.success).toBe(success);
  expect(report.shardCount).toBe(count);
  expect(report.testFiles).toHaveLength(files);
  expect(manifests.map((manifest) => manifest.shardIndex)).toEqual(
    Array.from({ length: count }, (unused, index) => index + 1)
  );
  const identities: string[] = manifests.flatMap((manifest) =>
    manifest.payload.testFiles.map((file) => file.path)
  );
  expect(new Set(identities).size).toBe(files);
  expect([...identities].sort()).toEqual(
    Array.from({ length: files }, (unused, index) => `tests/${index + 1}.test.js`)
  );
  for (const manifest of manifests) {
    expect(manifest.status).toBe('completed');
    expect(manifest.generation).toBe(report.generation);
    expect(manifest.shardCount).toBe(count);
    expect(manifest.payload.version).toBe(3);
    expect(manifest.payload.coverage.version).toBe(2);
  }
  expect(fixture.observations('before-collate').at(-1)?.generation).toBe(report.generation);
  expect(fixture.exists('temp/downstream/jest-collated.json')).toBe(success);
  const junit = fs.readFileSync(path.join(fixture.project, 'temp', 'collated', 'JUnit.xml'), 'utf8');
  expect(junit).toContain('<testsuites ');
  expect(junit.includes('<failure ') || junit.includes('<error ')).toBe(!success);
  return manifests;
}

async function exportGraphAsync(): Promise<IBuildXLRushGraph> {
  const filename = path.join(fixture.folder, 'temp', 'exported-graph.json');
  expectExit(
    await fixture.rushAsync(['--only', 'app', '--drop-graph', filename], {
      RUSH_BUILD_CACHE_ENABLED: '0',
      PRIVATE_EXPORT_SENTINEL: 'must-not-be-exported'
    }),
    0
  );
  const contents = fs.readFileSync(filename, 'utf8');
  expect(contents).not.toContain('PRIVATE_EXPORT_SENTINEL');
  expect(contents).not.toContain('must-not-be-exported');
  return JSON.parse(contents) as IBuildXLRushGraph;
}

// A deliberately small external consumer, not a second production scheduler or BuildXL emulator.
async function consumeGraphAsync(graph: IBuildXLRushGraph): Promise<Map<string, ICliResult>> {
  const results = new Map<string, ICliResult>();
  while (results.size < graph.nodes.length) {
    const node = graph.nodes.find(
      (candidate) =>
        !results.has(candidate.id) && candidate.dependencies.every((dependency) => results.has(dependency))
    );
    if (!node) throw new Error('Exported graph has no runnable operation.');
    const result = await fixture.runAsync(
      process.execPath,
      [
        '-e',
        "const r = require('node:child_process').spawnSync(process.argv[1], { shell: true, stdio: 'inherit' }); " +
          'if (r.error) throw r.error; process.exitCode = r.status === null ? 1 : r.status;',
        node.command
      ],
      node.workingDirectory,
      node.environmentVariables
    );
    results.set(node.id, result);
    if (result.code !== 0) break;
  }
  return results;
}

describe('real Rush + Heft + Jest sharding', () => {
  beforeAll(async () => {
    await fixture.initializeAsync();
  });
  beforeEach(async () => {
    await fixture.resetAsync();
  });
  afterAll(async () => {
    await fixture.restoreMatrixAsync();
  });

  it('exports and externally executes the configured graph with the same native generation', async () => {
    const graph = await exportGraphAsync();
    expect(graph.repoSettings.executionContractVersion).toBe(1);
    expect(fixture.observations('prepare')).toEqual([]);
    expect(fixture.suiteRuns()).toEqual([]);
    const shards = graph.nodes.filter((node) => /--shard=\d+\/2/.test(node.command));
    expect(shards).toHaveLength(2);
    expect(shards.map((node) => node.outputFolderNames).sort()).toEqual([
      ['temp/shards/1'],
      ['temp/shards/2']
    ]);
    for (const shard of shards) {
      expect(shard.cacheable).toBeUndefined();
      expect(shard.warningsAreAllowed).toBe(true);
    }
    const generation = shards[0].environmentVariables!.RUSH_SHARD_GENERATION;
    expect(generation).toMatch(/^[a-f0-9]{64}$/);
    const collator = graph.nodes.find((node) => node.command.includes('--only test-collate'))!;
    expect(collator.cacheable).toBe(false);
    expect(collator.environmentVariables).toEqual({ RUSH_SHARD_GENERATION: generation });
    expect(new Set(collator.dependencies)).toEqual(new Set(shards.map((node) => node.id)));
    const results = await consumeGraphAsync(graph);
    for (const result of results.values()) expectExit(result, 0);
    expect(results.size).toBe(graph.nodes.length);
    expectComplete(2, 4, true);
    expect(fixture.report().generation).toBe(generation);
    expectExit(await fixture.rushAsync(['--only', 'app'], { RUSH_BUILD_CACHE_ENABLED: '0' }), 0);
    expect(fixture.report().generation).toBe(generation);
  });

  it('defers external shard diagnostics to the collator and publishes a failing JUnit verdict', async () => {
    await fixture.resetAsync({
      coverage: false,
      jestOptions: { coverageThreshold: undefined },
      testBodies: ["test('real failure', () => expect(1).toBe(2));"]
    });
    const graph = await exportGraphAsync();
    const results = await consumeGraphAsync(graph);
    for (const shard of graph.nodes.filter((node) => /--shard=\d+\/2/.test(node.command))) {
      expectExit(results.get(shard.id)!, 0);
      expect(shard.warningsAreAllowed).toBe(true);
    }
    const collator = graph.nodes.find((node) => node.command.includes('--only test-collate'))!;
    expectExit(results.get(collator.id)!, 1);
    expectComplete(2, 1, false);
    expect(results.has(graph.nodes.find((node) => node.task === '_phase:consume')!.id)).toBe(false);
    const xml = fs.readFileSync(path.join(fixture.project, 'temp', 'collated', 'JUnit.xml'), 'utf8');
    expect(xml).toContain('name="real failure"');
    expect(xml).toContain('<failure ');
  });

  it('isolates four real managed project/phase groups across cache restoration, invalidation and failure', async () => {
    const groups: IManagedGroup[] = await fixture.configureMatrixAsync({
      projects: ['managed-a', 'managed-b'],
      phases: ['unit', 'verify']
    });
    const counts: number[] = [2, 2, 2, 2];
    const runs: number[] = [2, 2, 2, 2];
    const environment: NodeJS.ProcessEnv = {};
    let collations: number = 1;
    expectExit(await fixture.rushAsync(), 0);
    const initial: JestManifest[][] = groups.map((group) => fixture.manifests(2, group));
    let generations: string[] = groups.map((group) => fixture.report(group).generation);
    expect(new Set(generations).size).toBe(4);
    expect(fixture.archives()).toHaveLength(8);
    groups.forEach((group, index) => expectMatrixGroup(group, counts[index], runs[index], collations, true));

    fixture.clearGroupOutputs(groups);
    const warm: ICliResult = await fixture.rushAsync();
    expectExit(warm, 0);
    expect(warm.output).toContain('FROM CACHE: 8 operations');
    collations++;
    groups.forEach((group, index) => {
      expectMatrixGroup(group, counts[index], runs[index], collations, true);
      expect(fixture.manifests(2, group)).toEqual(initial[index]);
    });

    const evicted: Set<number> = new Set([0, 3]);
    for (const index of evicted) {
      const group: IManagedGroup = groups[index];
      const archive: string | undefined = fixture
        .archives()
        .find((name) => name.startsWith(`${group.projectName}_`) && name.includes(group.phaseName));
      expect(archive).toBeDefined();
      fs.unlinkSync(path.join(fixture.cache, archive!));
      runs[index]++;
    }
    fixture.clearGroupOutputs(groups);
    const partial: ICliResult = await fixture.rushAsync();
    expectExit(partial, 0);
    expect(partial.output).toContain('FROM CACHE: 6 operations');
    collations++;
    groups.forEach((group, index) => {
      expectMatrixGroup(group, counts[index], runs[index], collations, true);
      expect(fixture.report(group).generation).toBe(generations[index]);
      let restored: number = 0;
      fixture.manifests(2, group).forEach((manifest, shard) => {
        if (manifest.startedAt === initial[index][shard].startedAt) restored++;
      });
      expect(restored).toBe(evicted.has(index) ? 1 : 2);
    });
    expect(fixture.archives()).toHaveLength(8);

    for (const mutation of [
      'phase-environment',
      'project-identity',
      'project-phase-identity',
      'project-count',
      'project-jest-config',
      'one-group-failure'
    ]) {
      const affected: Set<number> = mutation.startsWith('project-') ? new Set([0, 1]) : new Set([0]);
      if (mutation === 'phase-environment') environment[groups[0].environmentName] = 'changed';
      if (mutation === 'project-identity') fixture.renameMatrixProject(groups, 'managed-a', 'renamed-a');
      if (mutation === 'project-phase-identity') fixture.renameMatrixPhase(groups[0], 'renamed-unit');
      if (mutation === 'project-count') {
        fixture.setGroupCount(groups[0], 3);
        counts[0] = 3;
      }
      if (mutation === 'project-jest-config') {
        const config: Record<string, unknown> = fixture.read('config/unit.jest.json', groups[0]);
        fixture.json('config/unit.jest.json', { ...config, testNamePattern: 'partition' }, groups[0]);
      }
      if (mutation === 'one-group-failure') environment[groups[0].environmentName] = 'fail';
      const before: JestManifest[][] = groups.map((group, index) =>
        fixture.manifests(counts[index] === 3 && mutation === 'project-count' ? 2 : counts[index], group)
      );
      await fixture.trackAsync();
      fixture.clearGroupOutputs(groups);
      const result: ICliResult = await fixture.rushAsync([], environment);
      expectExit(result, mutation === 'one-group-failure' ? 1 : 0);
      collations++;
      groups.forEach((group, index) => {
        if (affected.has(index)) runs[index] += 2;
        expectMatrixGroup(
          group,
          counts[index],
          runs[index],
          collations,
          mutation !== 'one-group-failure' || index !== 0
        );
        if (affected.has(index)) {
          expect(fixture.report(group).generation).not.toBe(generations[index]);
        } else {
          expect(fixture.report(group).generation).toBe(generations[index]);
          expect(fixture.manifests(counts[index], group)).toEqual(before[index]);
        }
      });
      generations = groups.map((group) => fixture.report(group).generation);
      expect(new Set(generations).size).toBe(4);
    }
    const failed: JestManifest[][] = groups.map((group, index) => fixture.manifests(counts[index], group));
    fixture.clearGroupOutputs(groups);
    const failedWarm: ICliResult = await fixture.rushAsync([], environment);
    expectExit(failedWarm, 1);
    expect(failedWarm.output).toContain('FROM CACHE: 9 operations');
    collations++;
    groups.forEach((group, index) => {
      expectMatrixGroup(group, counts[index], runs[index], collations, index !== 0);
      expect(fixture.manifests(counts[index], group)).toEqual(failed[index]);
    });
  });

  it('honors native cache write restrictions without disabling reads or fresh collation', async () => {
    await fixture.trackAsync();
    const environment: NodeJS.ProcessEnv = { RUSH_BUILD_CACHE_WRITE_ALLOWED: '0' };
    for (let attempt: number = 1; attempt <= 2; attempt++) {
      expectExit(await fixture.rushAsync([], environment), 0);
      expectComplete(2, 4, true);
      expect(fixture.suiteRuns()).toHaveLength(4 * attempt);
      expect(fixture.archives()).toHaveLength(0);
    }
    expectExit(await fixture.rushAsync(), 0);
    const manifests: JestManifest[] = fixture.manifests(2);
    const archives: string[] = fixture.archives();
    expect(archives).toHaveLength(2);
    fixture.remove('temp/shards');
    const readOnly: ICliResult = await fixture.rushAsync([], environment);
    expectExit(readOnly, 0);
    expect(readOnly.output).toContain('FROM CACHE: 2 operations');
    expectComplete(2, 4, true);
    expect(fixture.manifests(2)).toEqual(manifests);
    expect(fixture.archives()).toEqual(archives);
    expect(fixture.suiteRuns()).toHaveLength(12);
    expect(fixture.observations('before-collate')).toHaveLength(4);
  });

  it('honors native nonincremental cache-read and original-phase cache restrictions', async () => {
    const initialConfig: _IRushProjectJson = fixture.read('config/rush-project.json');
    initialConfig.incrementalBuildIgnoredGlobs = ['config/rush-project.json'];
    fixture.json('config/rush-project.json', initialConfig);
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 0);
    const manifests: JestManifest[] = fixture.manifests(2);
    const generation: string = fixture.report().generation;
    const commandPath: string = path.join(fixture.folder, 'common', 'config', 'rush', 'command-line.json');
    const original: string = fs.readFileSync(commandPath, 'utf8');
    try {
      const config: IFixtureCommandConfiguration = JSON.parse(original) as IFixtureCommandConfiguration;
      config.commands[0].incremental = false;
      fs.writeFileSync(commandPath, JSON.stringify(config));
      fixture.remove('temp/shards');
      const noRead: ICliResult = await fixture.rushAsync();
      expectExit(noRead, 0);
      expect(noRead.output).not.toContain('FROM CACHE');
      expectComplete(2, 4, true);
      expect(fixture.report().generation).toBe(generation);
      expect(fixture.suiteRuns()).toHaveLength(8);
      expect(fixture.archives()).toHaveLength(2);
      fixture
        .manifests(2)
        .forEach((manifest, index) => expect(manifest.startedAt).not.toBe(manifests[index].startedAt));
    } finally {
      fs.writeFileSync(commandPath, original);
    }
    const config: _IRushProjectJson = fixture.read('config/rush-project.json');
    const cachedManifests: JestManifest[] = fixture.manifests(2);
    config.operationSettings!.find(
      (settings) => settings.operationName === '_phase:test'
    )!.disableBuildCacheForOperation = true;
    fixture.json('config/rush-project.json', config);
    fixture.remove('temp/shards');
    fixture.remove('temp/test-shard');
    fixture.remove('temp/collated');
    fixture.remove('temp/downstream');
    const existingArchives: string[] = fixture.archives();
    const noDisabledRead: ICliResult = await fixture.rushAsync();
    expectExit(noDisabledRead, 0);
    expect(noDisabledRead.output).not.toContain('FROM CACHE');
    expectComplete(2, 4, true);
    expect(fixture.suiteRuns()).toHaveLength(12);
    expect(fixture.archives()).toEqual(existingArchives);

    config.operationSettings!.find(
      (settings) => settings.operationName === '_phase:test'
    )!.disableBuildCacheForOperation = false;
    fixture.json('config/rush-project.json', config);
    fixture.remove('temp/shards');
    fixture.remove('temp/test-shard');
    fixture.remove('temp/collated');
    fixture.remove('temp/downstream');
    const readsRestored: ICliResult = await fixture.rushAsync();
    expectExit(readsRestored, 0);
    expect(readsRestored.output).toContain('FROM CACHE: 2 operations');
    expect(fixture.manifests(2)).toEqual(cachedManifests);
    expect(fixture.suiteRuns()).toHaveLength(12);

    config.operationSettings!.find(
      (settings) => settings.operationName === '_phase:test'
    )!.disableBuildCacheForOperation = true;
    fixture.json('config/rush-project.json', config);
    fs.rmSync(fixture.cache, { recursive: true, force: true });
    for (let attempt: number = 1; attempt <= 2; attempt++) {
      fixture.remove('temp/shards');
      fixture.remove('temp/test-shard');
      fixture.remove('temp/collated');
      fixture.remove('temp/downstream');
      const disabled: ICliResult = await fixture.rushAsync();
      expectExit(disabled, 0);
      expect(disabled.output).not.toContain('FROM CACHE');
      expectComplete(2, 4, true);
      expect(fixture.suiteRuns()).toHaveLength(12 + 4 * attempt);
      expect(fixture.archives()).toHaveLength(0);
    }
    expect(fixture.observations('before-collate')).toHaveLength(6);
  });

  it('runs preparation once, executes a complete 1-based partition, restores ALL native archives without Jest', async () => {
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 0);
    const manifests: JestManifest[] = expectComplete(2, 4, true);
    expect(fixture.observations('prepare')).toEqual([{ generation: null }]);
    expect(fixture.suiteRuns()).toHaveLength(4);
    const coverage = fixture.read<CoverageMapData>(
      'temp/collated/jest-collated-coverage/coverage-final.json'
    );
    expect(Object.keys(coverage)).toEqual(['source.js']);
    expect(createCoverageMap(coverage).getCoverageSummary().branches.pct).toBe(100);
    expect(
      fs.readFileSync(path.join(fixture.project, 'temp/collated/jest-collated-coverage/lcov.info'), 'utf8')
    ).toContain('SF:source.js');
    const archives = fs.readdirSync(fixture.cache, { withFileTypes: true }).filter((entry) => entry.isFile());
    expect(archives.length).toBeGreaterThanOrEqual(2);
    const generation: string = fixture.report().generation;
    fixture.remove('temp/shards');
    fixture.remove('temp/test-shard');
    fixture.remove('temp/collated');
    fixture.remove('temp/downstream');
    const warm: ICliResult = await fixture.rushAsync();
    expectExit(warm, 0);
    expect(warm.output).toContain('FROM CACHE');
    expectComplete(2, 4, true);
    expect(fixture.manifests(2)).toEqual(manifests);
    expect(fixture.report().generation).toBe(generation);
    expect(fixture.suiteRuns()).toHaveLength(4);
    expect(fixture.observations('prepare')).toHaveLength(2);
    expect(fixture.observations('before-collate')).toHaveLength(2);
  });

  it('rebuilds only one evicted native archive and freshly collates a mixture of restored and new results', async () => {
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 0);
    const before: JestManifest[] = fixture.manifests(2);
    const archives = fs.readdirSync(fixture.cache, { withFileTypes: true }).filter((entry) => entry.isFile());
    expect(archives).toHaveLength(2);
    fs.unlinkSync(path.join(fixture.cache, archives[0].name));
    fixture.remove('temp/shards');
    expectExit(await fixture.rushAsync(), 0);
    const after: JestManifest[] = expectComplete(2, 4, true);
    expect(after[0].generation).toBe(before[0].generation);
    expect(after.filter((manifest, index) => manifest.startedAt === before[index].startedAt)).toHaveLength(1);
    expect(fixture.suiteRuns()).toHaveLength(6);
  });

  it('invalidates ALL sibling caches for source, shard count and shared Jest selection changes', async () => {
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync([], { FIXTURE_TEST_MODE: 'normal' }), 0);
    let generation: string = fixture.report().generation;
    let runs: number = fixture.suiteRuns().length;
    for (const change of ['source', 'count', 'selection', 'environment']) {
      if (change === 'source') fixture.write('source.js', "module.exports = (v) => v ? 'yes' : 'no';\n");
      if (change === 'count') fixture.setCount(3);
      if (change === 'selection') {
        const config = fixture.read<Record<string, unknown>>('config/jest.config.json');
        fixture.json('config/jest.config.json', { ...config, testNamePattern: 'yes|no' });
      }
      await fixture.trackAsync();
      const result: ICliResult = await fixture.rushAsync([], {
        FIXTURE_TEST_MODE: change === 'environment' ? 'changed' : 'normal'
      });
      expectExit(result, 0);
      expectComplete(change === 'source' ? 2 : 3, 4, true);
      expect(fixture.report().generation).not.toBe(generation);
      expect(fixture.suiteRuns()).toHaveLength(runs + 4);
      generation = fixture.report().generation;
      runs += 4;
    }
  });

  it('reruns managed shards for declared environment changes without archive caching or preparation', async () => {
    const cacheConfigurationPath: string = path.join(fixture.folder, 'common/config/rush/build-cache.json');
    const commandConfigurationPath: string = path.join(
      fixture.folder,
      'common/config/rush/command-line.json'
    );
    const originalCacheConfiguration: string = fs.readFileSync(cacheConfigurationPath, 'utf8');
    const originalCommandConfiguration: string = fs.readFileSync(commandConfigurationPath, 'utf8');
    try {
      fs.writeFileSync(
        cacheConfigurationPath,
        JSON.stringify({ buildCacheEnabled: false, cacheProvider: 'local-only' })
      );
      fs.writeFileSync(
        commandConfigurationPath,
        JSON.stringify({
          commands: [
            {
              commandKind: 'phased',
              name: 'test-shards',
              summary: 'Run managed tests without preparation',
              enableParallelism: true,
              incremental: true,
              phases: ['_phase:test', '_phase:consume']
            }
          ],
          phases: [
            { name: '_phase:test' },
            {
              name: '_phase:consume',
              dependencies: { self: ['_phase:test'] },
              missingScriptBehavior: 'silent'
            }
          ]
        })
      );
      await fixture.resetAsync({
        coverage: false,
        jestOptions: { coverageThreshold: undefined },
        testBodies: [
          "test('declared environment verdict', () => expect(process.env.FIXTURE_TEST_MODE).toBe('normal'));",
          "test('healthy sibling', () => expect(true).toBe(true));"
        ]
      });
      await fixture.trackAsync();
      expectExit(await fixture.rushAsync([], { FIXTURE_TEST_MODE: 'normal' }), 0);
      expectComplete(2, 2, true);
      const generation: string = fixture.report().generation;
      fixture.remove('temp/downstream');
      expectExit(await fixture.rushAsync([], { FIXTURE_TEST_MODE: 'changed' }), 1);
      expectComplete(2, 2, false);
      expect(fixture.report().generation).not.toBe(generation);
      expect(fixture.suiteRuns()).toHaveLength(4);
      expect(fixture.observations('prepare')).toHaveLength(0);
      expect(JSON.stringify(fixture.report().testFiles)).toContain('declared environment verdict');
    } finally {
      fs.writeFileSync(cacheConfigurationPath, originalCacheConfiguration);
      fs.writeFileSync(commandConfigurationPath, originalCommandConfiguration);
    }
  });

  (process.platform === 'win32' ? it : it.skip)(
    'invalidates native archives for differently cased inherited environment variables',
    async () => {
      const inheritedName: string = 'heft_shard_review_mode';
      await fixture.resetAsync({
        coverage: false,
        dependsOnEnvVars: ['HEFT_SHARD_REVIEW_MODE'],
        jestOptions: { coverageThreshold: undefined },
        testBodies: [
          "test('declared mode', () => expect(process.env.HEFT_SHARD_REVIEW_MODE).toBe('passing'));",
          "test('healthy sibling', () => expect(true).toBe(true));"
        ]
      });
      await fixture.trackAsync();
      expectExit(await fixture.rushAsync([], { [inheritedName]: 'passing' }), 0);
      expectComplete(2, 2, true);
      const generation: string = fixture.report().generation;
      expectExit(await fixture.rushAsync([], { [inheritedName]: 'passing' }), 0);
      expect(fixture.suiteRuns()).toHaveLength(2);
      expectExit(await fixture.rushAsync([], { [inheritedName]: 'failing' }), 1);
      expectComplete(2, 2, false);
      expect(fixture.report().generation).not.toBe(generation);
      expect(fixture.suiteRuns()).toHaveLength(4);
      expect(JSON.stringify(fixture.report().testFiles)).toContain('Received:');
    }
  );

  it('distinguishes absent and empty declared environment values in native cache identity', async () => {
    await fixture.resetAsync({
      coverage: false,
      dependsOnEnvVars: ['HEFT_SHARD_EMPTY_MODE'],
      jestOptions: { coverageThreshold: undefined },
      testBodies: [
        "test('first partition', () => expect(true).toBe(true));",
        "test('second partition', () => expect(true).toBe(true));"
      ]
    });
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync([], { HEFT_SHARD_EMPTY_MODE: undefined }), 0);
    const generation: string = fixture.report().generation;
    expectExit(await fixture.rushAsync([], { HEFT_SHARD_EMPTY_MODE: '' }), 0);
    expectComplete(2, 2, true);
    expect(fixture.report().generation).not.toBe(generation);
    expect(fixture.suiteRuns()).toHaveLength(4);
    expectExit(await fixture.rushAsync([], { HEFT_SHARD_EMPTY_MODE: '' }), 0);
    expect(fixture.suiteRuns()).toHaveLength(4);
  });

  it('rejects a declared uncovered collator output input before preparation or tests', async () => {
    await fixture.resetAsync({ provider: 'babel', jestOptions: { coverageReporters: ['html'] } });
    expectExit(await fixture.rushAsync(), 0);
    expectComplete(2, 4, true);
    const identity: string = 'temp/collated/jest-collated-coverage/sorter.js';
    const filename: string = path.join(fixture.project, identity);
    const original: string = fs.readFileSync(filename, 'utf8');
    const inventoryPath: string = path.join(
      fixture.project,
      'temp/collated/jest-collated-coverage.files.json'
    );
    const inventory: string = fs.readFileSync(inventoryPath, 'utf8');
    const runs: string[] = fixture.suiteRuns();
    const preparation = fixture.observations('prepare');
    const collation = fixture.observations('before-collate');
    const config: _IRushProjectJson = fixture.read('config/rush-project.json');
    const operation = config.operationSettings!.find((settings) => settings.operationName === '_phase:test')!;
    operation.dependsOnAdditionalFiles = [identity];
    fixture.json('config/rush-project.json', config);
    fixture.write(
      'tests/1.test.js',
      `test('reads uncovered fixture', () => expect(require('node:fs').readFileSync(` +
        `require('node:path').resolve(__dirname, '../${identity}'), 'utf8')).toContain('function'));`
    );
    // source.js remains the only coverage-selected file; native input registration, not
    // coverage metadata, must reject the cyclic read before Heft's preparation cleans it.
    expect(fixture.read<IFixtureCoverageSelection>('config/jest.config.json').collectCoverageFrom).toEqual([
      'source.js'
    ]);
    for (let attempt: number = 0; attempt < 2; attempt++) {
      const result: ICliResult = await fixture.rushAsync();
      expectExit(result, 1);
      expect(result.output).toContain('Configured output folder "temp/collated"');
      expect(result.output).toContain('additional input file');
      expect(result.output).toContain('sorter.js');
      expect(fixture.observations('prepare')).toEqual(preparation);
      expect(fixture.observations('before-collate')).toEqual(collation);
      expect(fixture.suiteRuns()).toEqual(runs);
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
      expect(fs.readFileSync(inventoryPath, 'utf8')).toBe(inventory);
    }
  });

  it.each([
    ['assertion', "test('failed assertion', () => expect(1).toBe(2));"],
    ['runtime', "throw new Error('suite import failed');"],
    ['timeout', "test('timeout retained', () => new Promise(() => {}), 20);"],
    ['snapshot', "test('snapshot retained', () => expect('actual').toMatchInlineSnapshot('\"expected\"'));"]
  ])(
    'records %s diagnostics while shards succeed, then blocks downstream; failed results remain red from cache',
    async (name, body) => {
      await fixture.resetAsync({
        threshold: 0,
        testBodies: [body, "test('healthy sibling', () => expect(require('../source')(true)).toBe('yes'));"]
      });
      await fixture.trackAsync();
      const cold: ICliResult = await fixture.rushAsync();
      expectExit(cold, 1);
      const manifests: JestManifest[] = expectComplete(2, 2, false);
      expect(manifests.reduce((sum, manifest) => sum + manifest.diagnosticCount, 0)).toBeGreaterThan(0);
      expect(fixture.report().diagnosticCount).toBeGreaterThan(0);
      const details: string = JSON.stringify(fixture.report().testFiles);
      if (name === 'assertion') expect(details).toContain('failed assertion');
      if (name === 'runtime') expect(details).toContain('suite import failed');
      if (name === 'timeout') expect(details).toContain('Exceeded timeout');
      if (name === 'snapshot') expect(fixture.report().snapshotFailure).toBe(true);
      expect(cold.output).toContain('BLOCKED');
      expect(fixture.suiteRuns()).toHaveLength(2);
      fixture.remove('temp/shards');
      const warm: ICliResult = await fixture.rushAsync();
      expectExit(warm, 1);
      expect(warm.output).toContain('FROM CACHE');
      expectComplete(2, 2, false);
      expect(fixture.manifests(2)).toEqual(manifests);
      expect(fixture.suiteRuns()).toHaveLength(2);
    }
  );

  it.each(['missing', 'corrupt', 'duplicate-file', 'extra', 'stale', 'mixed'])(
    'rejects %s restored results rather than preserving an old green report',
    async (fault) => {
      await fixture.trackAsync();
      expectExit(await fixture.rushAsync(), 0);
      fixture.json('temp/fault.json', { fault });
      const result: ICliResult = await fixture.rushAsync();
      expectExit(result, 1);
      expect(result.output).toContain('FROM CACHE');
      expect(result.output).toContain('BLOCKED');
      expect(fixture.exists('temp/collated/jest-collated.json')).toBe(false);
      expect(fixture.exists('temp/downstream/jest-collated.json')).toBe(false);
      expect(fixture.suiteRuns()).toHaveLength(4);
    }
  );

  it.each([false, true])(
    'retains all-suite import failures with coverage=%s and no healthy sibling',
    async (coverage) => {
      await fixture.resetAsync({
        coverage,
        threshold: 0,
        jestOptions: coverage ? undefined : { coverageThreshold: undefined },
        testBodies: [
          "throw new Error('first suite import failed');",
          "throw new Error('second suite import failed');"
        ]
      });
      await fixture.trackAsync();
      expectExit(await fixture.rushAsync(), 1);
      const manifests: JestManifest[] = expectComplete(2, 2, false);
      expect(manifests.map((manifest) => manifest.itemCount)).toEqual([0, 0]);
      expect(fixture.report().itemCount).toBe(0);
      expect(fixture.report().diagnosticCount).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(fixture.report().testFiles)).toContain('first suite import failed');
      expect(JSON.stringify(fixture.report().testFiles)).toContain('second suite import failed');
    }
  );

  it('accepts empty partitions and completed skipped/todo suites', async () => {
    await fixture.resetAsync({
      count: 3,
      threshold: 0,
      testBodies: [
        "test('one', () => expect(require('../source')(true)).toBe('yes'));",
        "test('two', () => expect(require('../source')(false)).toBe('no'));"
      ]
    });
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 0);
    expect(expectComplete(3, 2, true).filter((manifest) => manifest.itemCount === 0)).toHaveLength(1);
    await fixture.resetAsync({
      threshold: 0,
      testBodies: ["test.skip('skip', () => {});", "test.todo('todo');"]
    });
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 0);
    expect(expectComplete(2, 2, true).map((manifest) => manifest.itemCount)).toEqual([0, 0]);
    expect(fixture.report()).toMatchObject({ totals: { skipped: 1, todo: 1 }, diagnosticCount: 0 });
  });

  it.each([true, false])(
    'applies passWithNoTests=%s to a completed empty selection',
    async (passWithNoTests) => {
      await fixture.resetAsync({
        coverage: false,
        testBodies: [],
        jestOptions: { coverageThreshold: undefined }
      });
      const configPath: string = path.join(fixture.project, 'config', 'heft.json');
      const original: string = fs.readFileSync(configPath, 'utf8');
      const config: {
        phasesByName: {
          'test-shard': {
            tasksByName: { jest: { taskPlugin: { options?: { passWithNoTests?: boolean } } } };
          };
        };
      } = JSON.parse(original);
      config.phasesByName['test-shard'].tasksByName.jest.taskPlugin.options = { passWithNoTests };
      try {
        fixture.json('config/heft.json', config);
        await fixture.trackAsync();
        expectExit(await fixture.rushAsync(), passWithNoTests ? 0 : 1);
        expect(expectComplete(2, 0, passWithNoTests).map((manifest) => manifest.itemCount)).toEqual([0, 0]);
        expect(fixture.report().diagnosticCount).toBe(passWithNoTests ? 0 : 1);
      } finally {
        fs.writeFileSync(configPath, original);
      }
    }
  );

  it('cannot publish a verdict after a real bounded-heap OOM or externally terminated shard', async () => {
    for (const fault of ['oom', 'terminate']) {
      await fixture.resetAsync({
        threshold: 0,
        testBodies: [
          fault === 'oom'
            ? "test('bounded heap failure', () => { require('node:fs').writeFileSync('temp/fault-started', 'oom'); const retained = []; for (;;) retained.push(new Array(100000).fill(1)); });"
            : "test('terminated shard', () => { require('node:fs').writeFileSync('temp/fault-started', 'terminate'); process.kill(process.pid, 'SIGTERM'); });",
          "test('healthy sibling', () => expect(require('../source')(true)).toBe('yes'));"
        ]
      });
      const packageJson = fixture.read<{ scripts: Record<string, string> }>('package.json');
      const original: string = packageJson.scripts['_phase:test:shard'];
      packageJson.scripts['_phase:test:shard'] =
        `node --max-old-space-size=96 "${fixture.heftStart}" run --only test-shard --`;
      fixture.json('package.json', packageJson);
      try {
        await fixture.trackAsync();
        const result: ICliResult = await fixture.rushAsync();
        expectExit(result, 1);
        expect(result.output).toContain('BLOCKED');
        expect(fs.readFileSync(path.join(fixture.project, 'temp/fault-started'), 'utf8')).toBe(fault);
        if (fault === 'oom') expect(result.output).toMatch(/heap out of memory|heap limit/i);
        expect(fixture.observations('before-collate')).toHaveLength(0);
        expect(fixture.exists('temp/collated/jest-collated.json')).toBe(false);
        expect(fixture.exists('temp/downstream/jest-collated.json')).toBe(false);
        const entries = fs.readdirSync(path.join(fixture.project, 'temp', 'shards'), { withFileTypes: true });
        let markers: number = 0;
        for (const entry of entries) {
          if (entry.isDirectory() && fixture.exists(`temp/shards/${entry.name}/shard-manifest.json`))
            markers++;
        }
        expect(markers).toBeLessThan(2);
      } finally {
        packageJson.scripts['_phase:test:shard'] = original;
        fixture.json('package.json', packageJson);
      }
    }
  });

  it('retains ordinary failure exits for unsharded and bare partition invocations', async () => {
    await fixture.resetAsync({
      threshold: 0,
      testBodies: ["test('ordinary failure', () => expect(true).toBe(false));"]
    });
    for (const partition of [[], ['--shard=1/1']]) {
      expectExit(await fixture.heftAsync(['run', '--only', 'test-shard', '--', ...partition]), 1);
      expect(fixture.exists('temp/shards/1/shard-manifest.json')).toBe(false);
    }
  });

  it('merges raw nested-function V8 ranges before conversion and fails the true 80% threshold', async () => {
    await fixture.resetAsync({
      testBodies: [
        "test('outer true', () => expect(require('../source')(true)).toBe(1));",
        "test('outer false', () => expect(require('../source')(false)).toBe(3));"
      ]
    });
    fixture.write(
      'source.js',
      'function outer(x){ function inner(y){if(y)return 1; return 2;} if(x)return inner(x); return 3; }\nmodule.exports = outer;\n'
    );
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 1);
    expectComplete(2, 2, false);
    const map = createCoverageMap(
      fixture.read<CoverageMapData>('temp/collated/jest-collated-coverage/coverage-final.json')
    );
    expect(map.getCoverageSummary().branches.pct).toBe(80);
    expect(fixture.report().coverage.messages.join('\n')).toContain('not met: 80%');
    expect(fixture.manifests(2).map((manifest) => manifest.diagnosticCount)).toEqual([0, 0]);
  });

  it('supports real Babel instrumentation and merges complementary coverage', async () => {
    await fixture.resetAsync({ provider: 'babel' });
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 0);
    expectComplete(2, 4, true);
    expect(
      createCoverageMap(
        fixture.read<CoverageMapData>('temp/collated/jest-collated-coverage/coverage-final.json')
      ).getCoverageSummary().branches.pct
    ).toBe(100);
  });

  it('preserves canonical V8 coverage for Node modules with a shebang', async () => {
    await fixture.resetAsync({ jestOptions: { coverageDirectory: '<rootDir>/temp/standalone-coverage' } });
    const source: string = fs.readFileSync(path.join(fixture.project, 'source.js'), 'utf8');
    fixture.write('source.js', `#!/usr/bin/env node\n${source.replace(/\r?\n/g, '\r\n')}`);
    expectExit(await fixture.heftAsync(['run', '--only', 'test-shard', '--']), 0);
    const baseline = createCoverageMap(
      fixture.read<CoverageMapData>('temp/standalone-coverage/coverage-final.json')
    );
    const baselineFile = baseline.fileCoverageFor(path.join(fixture.project, 'source.js')).data;
    expect(baselineFile.fnMap[0].decl.start.column).toBe(-2);
    await fixture.trackAsync();
    expectExit(await fixture.rushAsync(), 0);
    expectComplete(2, 4, true);
    const merged = createCoverageMap(
      fixture.read<CoverageMapData>('temp/collated/jest-collated-coverage/coverage-final.json')
    );
    expect(merged.getCoverageSummary().toJSON()).toEqual(baseline.getCoverageSummary().toJSON());
    const mergedFile = merged.fileCoverageFor('source.js').data;
    for (const field of ['statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'] as const) {
      expect(mergedFile[field]).toEqual(baselineFile[field]);
    }
  });

  it.each([
    { globalSetup: '<rootDir>/crash.cjs' },
    { reporters: ['<rootDir>/unsafe-reporter.cjs'] },
    { coverageReporters: [['json', { file: '../unsafe.json' }]] }
  ])('fails closed on harness crash or unsafe configuration %j', async (jestOptions) => {
    await fixture.resetAsync({ jestOptions });
    fixture.write('crash.cjs', 'module.exports = () => process.exit(27);');
    await fixture.trackAsync();
    const result: ICliResult = await fixture.rushAsync();
    expectExit(result, 1);
    expect(result.output).toContain('BLOCKED');
    expect(fixture.exists('temp/shards/1/shard-manifest.json')).toBe(false);
    expect(fixture.exists('temp/shards/2/shard-manifest.json')).toBe(false);
    expect(fixture.exists('temp/collated/jest-collated.json')).toBe(false);
  });

  it('rejects clean/watch before preparation, and invalidates a previous manifest on a crashed retry', async () => {
    fixture.write('temp/shards/1/shard-manifest.json', 'old marker');
    for (const mode of ['clean', 'watch']) {
      const result: ICliResult = await fixture.heftAsync(
        [
          mode === 'watch' ? 'run-watch' : 'run',
          '--to',
          'test-shard',
          '--',
          '--shard=1/2',
          '--shard-output-directory=temp/shards/1',
          ...(mode === 'clean' ? ['--clean'] : [])
        ],
        'manual-current'
      );
      expectExit(result, 1);
      expect(fixture.observations('prepare')).toHaveLength(0);
      expect(fs.readFileSync(path.join(fixture.project, 'temp/shards/1/shard-manifest.json'), 'utf8')).toBe(
        'old marker'
      );
    }
    const config = fixture.read<Record<string, unknown>>('config/jest.config.json');
    fixture.json('config/jest.config.json', { ...config, globalSetup: '<rootDir>/crash.cjs' });
    fixture.write('crash.cjs', 'module.exports = () => process.exit(27);');
    expectExit(
      await fixture.heftAsync(
        ['run', '--only', 'test-shard', '--', '--shard=1/2', '--shard-output-directory=temp/shards/1'],
        'manual-current'
      ),
      27
    );
    expect(fixture.exists('temp/shards/1/shard-manifest.json')).toBe(false);
    expect(fixture.exists('temp/collated/jest-collated.json')).toBe(false);
  });
});
