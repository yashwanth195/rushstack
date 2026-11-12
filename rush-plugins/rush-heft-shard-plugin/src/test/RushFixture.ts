// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RushConfiguration } from '@microsoft/rush-lib/lib/api/RushConfiguration';
import { BuildCacheConfiguration } from '@microsoft/rush-lib/lib/api/BuildCacheConfiguration';
import { RushProjectConfiguration } from '@microsoft/rush-lib/lib/api/RushProjectConfiguration';
import { RushSession } from '@microsoft/rush-lib/lib/pluginFramework/RushSession';
import type { IRushPlugin } from '@microsoft/rush-lib/lib/pluginFramework/IRushPlugin';
import {
  type IOperationGraphContext,
  PhasedCommandHooks
} from '@microsoft/rush-lib/lib/pluginFramework/PhasedCommandHooks';
import type { IOperationRunnerContext } from '@microsoft/rush-lib/lib/logic/operations/IOperationRunner';
import type { IOperationExecutionResult } from '@microsoft/rush-lib/lib/logic/operations/IOperationExecutionResult';
import type { Operation } from '@microsoft/rush-lib/lib/logic/operations/Operation';
import { OperationStatus } from '@microsoft/rush-lib/lib/logic/operations/OperationStatus';
import { CommandLineConfiguration } from '@microsoft/rush-lib/lib/api/CommandLineConfiguration';
import { RushGlobalFolder } from '@microsoft/rush-lib/lib/api/RushGlobalFolder';
import { OperationGraph } from '@microsoft/rush-lib/lib/logic/operations/OperationGraph';
import { PhasedOperationPlugin } from '@microsoft/rush-lib/lib/logic/operations/PhasedOperationPlugin';
import { ShardedPhasedOperationPlugin } from '@microsoft/rush-lib/lib/logic/operations/ShardedPhaseOperationPlugin';
import { ShellOperationRunnerPlugin } from '@microsoft/rush-lib/lib/logic/operations/ShellOperationRunnerPlugin';
import { LegacySkipPlugin } from '@microsoft/rush-lib/lib/logic/operations/LegacySkipPlugin';
import { AutoinstallerPluginLoader } from '@microsoft/rush-lib/lib/pluginFramework/PluginLoader/AutoinstallerPluginLoader';
import { InputsSnapshot } from '@microsoft/rush-lib/lib/logic/incremental/InputsSnapshot';
import { FileSystem, JsonFile } from '@rushstack/node-core-library';
import { MockWritable, StringBufferTerminalProvider, Terminal } from '@rushstack/terminal';
import { CommandLineParser, type CommandLineStringParameter } from '@rushstack/ts-command-line';

export const PLUGIN_NAME: string = 'rush-heft-shard-plugin';
export const PACKAGE_FOLDER: string = path.resolve(__dirname, '..', '..');
export const WORK_FOLDER: string = path.join(PACKAGE_FOLDER, '.test-work');
const RUSH_VERSION: string = (require('@microsoft/rush-lib/package.json') as { version: string }).version;

export interface IFixtureOptions {
  count?: number;
  filter?: string;
  phaseName?: string;
  managedPhaseNames?: string[];
  packageName?: string;
  sharded?: boolean;
  enablePlugin?: boolean;
  buildCacheEnabled?: boolean;
  changedProjectsOnly?: boolean;
  isWatch?: boolean;
  phaseEnvVars?: string[];
  shardEnvVars?: string[];
  shardFiles?: string[];
  collatorCommand?: string;
  mutateOperations?: (operations: Set<Operation>) => void;
  configureHooks?: (hooks: PhasedCommandHooks) => void;
  beforePluginLoad?: () => void;
}

export interface ISnapshotOptions {
  source?: string;
  upstream?: string;
  environment?: Record<string, string | undefined>;
}

export interface IFixture {
  folder: string;
  graph: OperationGraph;
  context: IOperationGraphContext;
  hooks: PhasedCommandHooks;
  preShard: Operation | undefined;
  collator: Operation;
  shards: Operation[];
  snapshot: (options?: ISnapshotOptions) => InputsSnapshot;
}

class FilterCommand extends CommandLineParser {
  public readonly filter: CommandLineStringParameter = this.defineStringParameter({
    parameterLongName: '--filter',
    argumentName: 'FILTER',
    description: 'Test selection'
  });

  public constructor() {
    super({ toolFilename: 'fixture', toolDescription: 'Identity test fixture' });
  }

  protected override async onExecuteAsync(): Promise<void> {}
}

export async function createFixtureAsync(options: IFixtureOptions = {}): Promise<IFixture> {
  const folder: string = path.join(WORK_FOLDER, randomUUID());
  const phaseName: string = options.phaseName ?? '_phase:test';
  const packageName: string = options.packageName ?? 'app';
  const sharded: boolean = options.sharded !== false;
  const terminalProvider: StringBufferTerminalProvider = new StringBufferTerminalProvider();
  const terminal: Terminal = new Terminal(terminalProvider);
  const save = (relativePath: string, data: object): void => {
    JsonFile.save(data, path.join(folder, relativePath), { ensureFolderExists: true });
  };
  save('rush.json', {
    rushVersion: RUSH_VERSION,
    pnpmVersion: '10.27.0',
    projects: [
      { packageName, projectFolder: 'projects/app' },
      { packageName: 'upstream', projectFolder: 'projects/upstream' }
    ]
  });
  save('projects/app/package.json', {
    name: packageName,
    version: '1.0.0',
    dependencies: { upstream: 'workspace:*' },
    scripts: {
      '_phase:build': 'node build.js',
      [phaseName]: options.collatorCommand ?? 'node collate.js',
      [`${phaseName}:shard`]: 'node test.js'
    }
  });
  save('projects/upstream/package.json', {
    name: 'upstream',
    version: '1.0.0',
    scripts: { '_phase:build': 'node build.js' }
  });
  save('projects/app/config/rush-project.json', {
    operationSettings: [
      {
        operationName: phaseName,
        dependsOnEnvVars: options.phaseEnvVars ?? ['TEST_MODE'],
        ...(sharded
          ? {
              sharding: {
                count: options.count ?? 2,
                shardOperationSettings: {
                  dependsOnEnvVars: options.shardEnvVars ?? [],
                  dependsOnAdditionalFiles: options.shardFiles ?? []
                }
              }
            }
          : {})
      }
    ]
  });
  save('common/config/rush/command-line.json', {
    phases: [
      { name: '_phase:build', dependencies: { upstream: ['_phase:build'] } },
      { name: phaseName, dependencies: { self: ['_phase:build'] }, missingScriptBehavior: 'silent' }
    ],
    commands: [
      {
        commandKind: 'phased',
        name: 'test-shards',
        summary: 'Test',
        phases: [phaseName],
        enableParallelism: true
      }
    ]
  });
  if (options.buildCacheEnabled !== undefined) {
    save('common/config/rush/build-cache.json', {
      buildCacheEnabled: options.buildCacheEnabled,
      cacheProvider: 'local-only'
    });
  }
  const pluginConfiguration = {
    packageName: PLUGIN_NAME,
    pluginName: PLUGIN_NAME,
    autoinstallerName: 'shard-identity'
  };
  save('common/config/rush/rush-plugins.json', { plugins: [pluginConfiguration] });
  save(`common/config/rush-plugins/${PLUGIN_NAME}.json`, {
    phaseNames: options.managedPhaseNames ?? [phaseName]
  });
  save('common/autoinstallers/shard-identity/package.json', {
    name: 'shard-identity',
    version: '1.0.0',
    private: true,
    dependencies: {
      [PLUGIN_NAME]: `link:${path
        .relative(path.join(folder, 'common', 'autoinstallers', 'shard-identity'), PACKAGE_FOLDER)
        .replace(/\\/g, '/')}`
    }
  });

  const rushConfiguration: RushConfiguration = RushConfiguration.loadFromConfigurationFile(
    path.join(folder, 'rush.json')
  );
  const commandLineConfiguration: CommandLineConfiguration = CommandLineConfiguration.tryLoadFromFile(
    path.join(folder, 'common', 'config', 'rush', 'command-line.json')
  )!;
  const phase = commandLineConfiguration.phases.get(phaseName)!;
  const filterCommand: FilterCommand = new FilterCommand();
  await filterCommand.executeAsync(options.filter ? ['--filter', options.filter] : []);
  phase.associatedParameters.add(filterCommand.filter);

  const projectConfigurations: Map<(typeof rushConfiguration.projects)[number], RushProjectConfiguration> =
    new Map();
  for (const project of rushConfiguration.projects) {
    const configuration: RushProjectConfiguration | undefined =
      await RushProjectConfiguration.tryLoadForProjectAsync(project, terminal);
    if (configuration) {
      projectConfigurations.set(project, configuration);
    }
  }
  const session: RushSession = new RushSession({ terminalProvider, getIsDebugMode: () => false });
  const context: IOperationGraphContext = {
    buildCacheConfiguration: await BuildCacheConfiguration.tryLoadAsync(terminal, rushConfiguration, session),
    changedProjectsOnly: options.changedProjectsOnly ?? false,
    cobuildConfiguration: undefined,
    customParameters: new Map([['--filter', filterCommand.filter]]),
    includePhaseDeps: true,
    isIncrementalBuildAllowed: true,
    isWatch: options.isWatch ?? false,
    parallelism: 1,
    phaseSelection: new Set([phase]),
    projectConfigurations,
    projectSelection: new Set([rushConfiguration.projectsByName.get(packageName)!]),
    rushConfiguration
  };
  const hooks: PhasedCommandHooks = new PhasedCommandHooks();
  new PhasedOperationPlugin().apply(hooks);
  new ShardedPhasedOperationPlugin().apply(hooks);
  new ShellOperationRunnerPlugin().apply(hooks);
  if (!context.buildCacheConfiguration?.buildCacheEnabled) {
    new LegacySkipPlugin({
      terminal,
      changedProjectsOnly: context.changedProjectsOnly,
      isIncrementalBuildAllowed: context.isIncrementalBuildAllowed,
      allowWarningsInSuccessfulBuild: true
    }).apply(hooks);
  }

  if (options.enablePlugin !== false) {
    // Emulate only package installation. Manifest copying, options validation, entry point loading,
    // the public session hooks and the native graph/record/hash implementations below are real Rush.
    const nodeModules: string = path.join(
      folder,
      'common',
      'autoinstallers',
      'shard-identity',
      'node_modules'
    );
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.symlinkSync(PACKAGE_FOLDER, path.join(nodeModules, PLUGIN_NAME), 'junction');
    const loader: AutoinstallerPluginLoader = new AutoinstallerPluginLoader({
      pluginConfiguration,
      rushConfiguration,
      rushGlobalFolder: new RushGlobalFolder(),
      terminal,
      restrictConsoleOutput: true
    });
    loader.update();
    options.beforePluginLoad?.();
    const plugin: IRushPlugin = loader.load()!;
    plugin.apply(session, rushConfiguration);
    await session.hooks.runAnyPhasedCommand.promise({
      actionName: 'test-shards',
      hooks,
      sessionAbortController: new AbortController()
    });
  }
  options.configureHooks?.(hooks);
  const operations: Set<Operation> = await hooks.createOperationsAsync.promise(new Set(), context);
  options.mutateOperations?.(operations);
  const graph: OperationGraph = new OperationGraph(operations, {
    quietMode: true,
    debugMode: false,
    parallelism: 1,
    allowOversubscription: false,
    destinations: [new MockWritable()],
    abortController: new AbortController()
  });
  await hooks.onGraphCreatedAsync.promise(graph, context);
  let preShard: Operation | undefined;
  let collator: Operation | undefined;
  const shards: Operation[] = [];
  for (const operation of operations) {
    if (operation.associatedPhase === phase) {
      if (operation.settings?.sharding && operation.isNoOp) {
        preShard = operation;
      } else if (operation.settings?.operationName === `${phaseName}:shard`) {
        shards.push(operation);
      } else {
        collator = operation;
      }
    }
  }

  const snapshot = (snapshotOptions: ISnapshotOptions = {}): InputsSnapshot => {
    const files: Map<string, string> = new Map([
      ['projects/app/source.ts', snapshotOptions.source ?? 'export const input = 1;'],
      ['projects/upstream/source.ts', snapshotOptions.upstream ?? 'export const input = 2;']
    ]);
    const hashes: Map<string, string> = new Map();
    for (const [relativePath, content] of files) {
      FileSystem.writeFile(path.join(folder, relativePath), content, { ensureFolderExists: true });
      hashes.set(relativePath, createHash('sha1').update(content).digest('hex'));
    }
    return new InputsSnapshot({
      hashes,
      hasUncommittedChanges: false,
      lookupByPath: rushConfiguration.getProjectLookupForRoot(folder),
      projectMap: new Map(
        rushConfiguration.projects.map((project) => [
          project,
          { projectConfig: projectConfigurations.get(project) }
        ])
      ),
      rootDir: folder,
      environment: snapshotOptions.environment ?? { TEST_MODE: 'normal' }
    });
  };
  return { folder, graph, context, hooks, preShard, collator: collator!, shards, snapshot };
}

export interface IPlannedRun {
  records: ReadonlyMap<Operation, IOperationExecutionResult>;
  generation: string | undefined;
  shardHashes: string[];
}

export async function planAsync(fixture: IFixture, options?: ISnapshotOptions): Promise<IPlannedRun> {
  let records: ReadonlyMap<Operation, IOperationExecutionResult> = new Map();
  fixture.graph.hooks.onIterationScheduled.tap('capture-current-records', (currentRecords) => {
    records = currentRecords;
  });
  await fixture.graph.scheduleIterationAsync({ inputsSnapshot: fixture.snapshot(options) });
  const generation: string | undefined = (
    records.get(fixture.collator)! as IOperationExecutionResult & IOperationRunnerContext
  ).environment?.RUSH_SHARD_GENERATION;
  const shardHashes: string[] = fixture.shards.map((shard) => records.get(shard)!.getStateHash());
  return { records, generation, shardHashes };
}

export function environmentFor(record: IOperationExecutionResult): Record<string, string | undefined> {
  return (record as IOperationExecutionResult & IOperationRunnerContext).environment!;
}

export function prepareShellExecution(fixture: IFixture): void {
  for (const project of fixture.context.rushConfiguration.projects) {
    FileSystem.writeFile(path.join(project.projectFolder, 'build.js'), '');
  }
  const projectFolder: string = fixture.collator.associatedProject.projectFolder;
  FileSystem.writeFile(
    path.join(projectFolder, 'test.js'),
    `
const fs = require('node:fs');
const shard = process.argv.find((argument) => argument.startsWith('--shard=')).slice(8).split('/')[0];
const failed = fs.existsSync('diagnostic');
fs.writeFileSync('manifest-' + shard + '.json', JSON.stringify({
  generation: process.env.RUSH_SHARD_GENERATION,
  failed
}));
if (failed) console.error('Recorded test diagnostic');
`
  );
  FileSystem.writeFile(
    path.join(projectFolder, 'collate.js'),
    `
const fs = require('node:fs');
const count = Number(process.argv.find((argument) => argument.startsWith('--shard-count=')).slice(14));
for (let index = 1; index <= count; index++) {
  const result = JSON.parse(fs.readFileSync('manifest-' + index + '.json', 'utf8'));
  if (result.generation !== process.env.RUSH_SHARD_GENERATION || result.failed) process.exitCode = 1;
}
`
  );
}

export async function executeWithoutShellAsync(
  fixture: IFixture,
  shardStatus: OperationStatus
): Promise<Map<Operation, string | undefined>> {
  const environments: Map<Operation, string | undefined> = new Map();
  const shards: Set<Operation> = new Set(fixture.shards);
  fixture.graph.hooks.beforeExecuteOperationAsync.tapPromise('substitute-shell-io', async (record) => {
    if (shards.has(record.operation) && shardStatus === OperationStatus.FromCache) {
      // A cache hit never asks the shell runner for its environment.
      return OperationStatus.FromCache;
    }
    environments.set(record.operation, record.environment?.RUSH_SHARD_GENERATION);
    return OperationStatus.Success;
  });
  const result = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
  expect(result.status).toBe(OperationStatus.Success);
  for (const shard of fixture.shards) {
    expect(result.operationResults.get(shard)!.status).toBe(shardStatus);
  }
  return environments;
}
