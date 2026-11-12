// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { _IRushProjectJson } from '@microsoft/rush-lib';

import type { IJestCollatedReport } from '@rushstack/heft-jest-plugin/lib/JestCollation';
import type { IJestShardPayload } from '@rushstack/heft-jest-plugin/lib/JestShardPayload';
import { SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME } from '@rushstack/heft-jest-plugin/lib/JestShardExecution';
import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';

const PACKAGE_FOLDER: string = path.resolve(__dirname, '..', '..');
const PLUGIN_PACKAGE_NAME: string = '@rushstack/rush-heft-shard-plugin';
const PLUGIN_NAME: string = 'rush-heft-shard-plugin';
const GRAPH_PLUGIN_PACKAGE: string = '@rushstack/rush-buildxl-graph-plugin';
const GRAPH_PLUGIN_NAME: string = 'rush-buildxl-graph-plugin';
const REPOSITORY_FOLDER: string = path.resolve(PACKAGE_FOLDER, '..', '..');
const RUSH_PNPM_SCRIPT: string = path.join(
  REPOSITORY_FOLDER,
  'common',
  'scripts',
  'install-run-rush-pnpm.js'
);
const PACKAGE_NAMES: string[] = ['@rushstack/heft', '@rushstack/heft-jest-plugin'];

export interface ICliResult {
  code: number;
  output: string;
}

export interface IFixtureOptions {
  count?: number;
  dependsOnEnvVars?: string[];
  coverage?: boolean;
  provider?: 'v8' | 'babel';
  threshold?: number;
  testBodies?: string[];
  jestOptions?: Record<string, unknown>;
}

export interface IMatrixOptions {
  projects: string[];
  phases: string[];
}

export interface IManagedGroup {
  projectName: string;
  phaseName: string;
  rushPhaseName: string;
  projectFolder: string;
  shardFolder: string;
  outputFolder: string;
  downstreamFolder: string;
  environmentName: string;
}

interface IFixtureHeftConfiguration {
  phasesByName: Record<string, { cleanFiles?: object[] }>;
}

interface IFixtureProject {
  packageName: string;
  projectFolder: string;
}

interface IFixtureRushConfiguration {
  projects: IFixtureProject[];
}

interface IFixturePackageJson {
  name: string;
  scripts: Record<string, string>;
}

interface IFixturePhase {
  name: string;
  dependencies?: { self: string[] };
  missingScriptBehavior: string;
}

interface IFixtureCommand {
  phases: string[];
}

interface IFixtureCommandLine {
  commands: IFixtureCommand[];
  phases: IFixturePhase[];
}

interface IFixtureIdentityOptions {
  phaseNames: string[];
}

export interface IObservation {
  // eslint-disable-next-line @rushstack/no-new-null -- JSON records explicitly distinguish unmanaged children.
  generation: string | null;
}

export type JestManifest = IShardResultManifest & { payload: IJestShardPayload };

export class RushHeftFixture {
  public readonly folder: string = path.join(PACKAGE_FOLDER, 'temp', 'rush fixture');
  public readonly project: string = path.join(this.folder, 'projects', 'app');
  public readonly cache: string = path.join(this.folder, 'common', 'temp', 'build-cache');
  public readonly heftStart: string = path.join(
    path.dirname(require.resolve('@rushstack/heft/package.json')),
    'lib-commonjs',
    'start.js'
  );
  private readonly _rushStart: string = path.join(
    path.dirname(require.resolve('@microsoft/rush-lib/package.json')),
    'lib-commonjs',
    'start.js'
  );
  private _invocation: number = 0;
  private _activeInvocations: number = 0;
  private readonly _matrixOriginalFiles: Map<string, string> = new Map();
  private readonly _matrixProjects: Set<string> = new Set();

  public write(relative: string, content: string, group?: IManagedGroup): void {
    const filename: string = path.join(group?.projectFolder ?? this.project, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }

  public json(relative: string, data: unknown, group?: IManagedGroup): void {
    this.write(relative, JSON.stringify(data), group);
  }

  public read<T>(relative: string, group?: IManagedGroup): T {
    return JSON.parse(
      fs.readFileSync(path.join(group?.projectFolder ?? this.project, relative), 'utf8')
    ) as T;
  }

  public exists(relative: string): boolean {
    return fs.existsSync(path.join(this.project, relative));
  }

  public remove(relative: string): void {
    fs.rmSync(path.join(this.project, relative), { recursive: true, force: true });
  }

  public report(group?: IManagedGroup): IJestCollatedReport {
    return this.read<IJestCollatedReport>(
      `${group?.outputFolder ?? 'temp/collated'}/jest-collated.json`,
      group
    );
  }

  public manifests(count: number, group?: IManagedGroup): JestManifest[] {
    return Array.from({ length: count }, (unused, index) =>
      this.read<JestManifest>(
        `${group?.shardFolder ?? 'temp/shards'}/${index + 1}/shard-manifest.json`,
        group
      )
    );
  }

  public observations(action: string, group?: IManagedGroup): IObservation[] {
    const filename: string = path.join(
      group?.projectFolder ?? this.project,
      'temp',
      'instrumentation',
      `${action}.jsonl`
    );
    return fs.existsSync(filename)
      ? fs
          .readFileSync(filename, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as IObservation)
      : [];
  }

  public suiteRuns(group?: IManagedGroup): string[] {
    const filename: string = path.join(
      group?.projectFolder ?? this.project,
      'temp',
      'instrumentation',
      group ? `${group.phaseName}-suites.jsonl` : 'suites.jsonl'
    );
    return fs.existsSync(filename)
      ? fs
          .readFileSync(filename, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string)
      : [];
  }

  public async runAsync(
    executable: string,
    args: string[],
    cwd: string = this.folder,
    environment: NodeJS.ProcessEnv = {}
  ): Promise<ICliResult> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // An outer Rush test invocation must not override this nested repository's cache or child identity.
    for (const key of Object.keys(env)) {
      if (key.startsWith('RUSH_') || key.startsWith('GIT_') || key === 'JEST_WORKER_ID') delete env[key];
    }
    Object.assign(env, environment, { FORCE_COLOR: '0', CI: 'true' });
    const log: string = path.join(this.folder, 'logs', `${++this._invocation}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    return await new Promise<ICliResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      });
      this._activeInvocations++;
      let output: string = '';
      let timedOut: boolean = false;
      const timer: NodeJS.Timeout = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) {
            if (process.platform === 'win32') {
              execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
            } else {
              process.kill(-child.pid, 'SIGKILL');
            }
          }
        } catch (error) {
          reject(new Error(`Could not terminate fixture process ${child.pid}: ${String(error)}`));
        }
      }, 480000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        this._activeInvocations--;
        clearTimeout(timer);
        fs.writeFileSync(log, output);
        if (timedOut || signal || code === null) {
          reject(
            new Error(
              `Fixture process terminated, not a test verdict (${signal}; timeout=${timedOut}). ${log}\n${output}`
            )
          );
        } else {
          resolve({ code, output });
        }
      });
    });
  }

  public async rushAsync(args: string[] = [], environment?: NodeJS.ProcessEnv): Promise<ICliResult> {
    return await this.runAsync(
      process.execPath,
      [this._rushStart, 'test-shards', '--parallelism', '2', '--verbose', ...args],
      this.folder,
      environment
    );
  }

  public async heftAsync(args: string[], generation?: string): Promise<ICliResult> {
    return await this.runAsync(process.execPath, [this.heftStart, ...args], this.project, {
      RUSH_SHARD_GENERATION: generation
    });
  }

  public async trackAsync(): Promise<void> {
    const result: ICliResult = await this.runAsync('git', ['add', '--all', '--', '.']);
    if (result.code) throw new Error(result.output);
  }

  public async initializeAsync(): Promise<void> {
    // Targeted local regressions can reuse an explicitly provisioned fixture without installing
    // dependencies or creating another nested Git repository. Missing state is an error.
    if (process.env.HEFT_SHARD_TEST_REUSE_FIXTURE === '1') {
      fs.accessSync(path.join(this.folder, 'common', 'temp', 'last-install.flag'));
      for (const name of PACKAGE_NAMES) {
        const installed: string = fs.realpathSync(path.join(this.project, 'node_modules', name));
        const expected: string = fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`)));
        if (installed !== expected) {
          throw new Error(`Existing native fixture must use the current workspace package "${name}".`);
        }
      }
      for (const [packageName, entryPoints] of [
        [PLUGIN_PACKAGE_NAME, ['HeftShardIdentityPlugin.js']],
        [GRAPH_PLUGIN_PACKAGE, ['index.js', 'DropBuildGraphPlugin.js', 'GraphProcessor.js', 'dropGraph.js']]
      ] as const) {
        const installed: string = fs.realpathSync(
          path.join(this.folder, 'common', 'autoinstallers', 'shard-identity', 'node_modules', packageName)
        );
        const current: string = fs.realpathSync(path.dirname(require.resolve(`${packageName}/package.json`)));
        const installedPackage: { name: string; version: string } = JSON.parse(
          fs.readFileSync(path.join(installed, 'package.json'), 'utf8')
        ) as { name: string; version: string };
        const currentPackage: { name: string; version: string } = JSON.parse(
          fs.readFileSync(path.join(current, 'package.json'), 'utf8')
        ) as { name: string; version: string };
        if (
          installedPackage.name !== currentPackage.name ||
          installedPackage.version !== currentPackage.version
        ) {
          throw new Error(`Reused native fixture must load the current packed ${packageName} package.`);
        }
        for (const relativePath of [
          'rush-plugin-manifest.json',
          ...entryPoints.map((entryPoint) => path.join('lib-commonjs', entryPoint))
        ]) {
          if (
            fs.readFileSync(path.join(installed, relativePath), 'utf8') !==
            fs.readFileSync(path.join(current, relativePath), 'utf8')
          ) {
            throw new Error(`Reused native fixture must load the current packed ${packageName} package.`);
          }
        }
      }
      const head: ICliResult = await this.runAsync('git', ['rev-parse', '--verify', 'HEAD']);
      if (head.code) throw new Error(head.output);
      const heftConfig: IFixtureHeftConfiguration = this.read('config/heft.json');
      heftConfig.phasesByName['test-prepare'].cleanFiles = this._cleanFolders('temp', [
        'shards',
        'collated',
        'test-shard',
        'downstream'
      ]);
      this.json('config/heft.json', heftConfig);
      return;
    }
    fs.rmSync(this.folder, { recursive: true, force: true });
    const identityArchivePath: string = await this._packPluginAsync(PLUGIN_PACKAGE_NAME);
    const graphArchivePath: string = await this._packPluginAsync(GRAPH_PLUGIN_PACKAGE);
    const save = (relative: string, data: unknown): void => {
      const filename: string = path.join(this.folder, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, JSON.stringify(data));
    };
    save('rush.json', {
      rushVersion: '5.179.0',
      pnpmVersion: '10.27.0',
      telemetryEnabled: false,
      projects: [
        { packageName: 'app', projectFolder: 'projects/app' },
        { packageName: 'ordinary', projectFolder: 'projects/ordinary' }
      ]
    });
    fs.writeFileSync(
      path.join(this.folder, '.gitignore'),
      'node_modules/\ntemp/\n.rush/\nrush-logs/\nlogs/\n.heft-jest-shard-locks/\n'
    );
    save('common/config/rush/build-cache.json', { buildCacheEnabled: true, cacheProvider: 'local-only' });
    save('common/config/rush/experiments.json', { buildCacheWithAllowWarningsInSuccessfulBuild: true });
    save('common/config/rush/command-line.json', {
      commands: [
        {
          commandKind: 'phased',
          name: 'test-shards',
          summary: 'Run managed tests',
          enableParallelism: true,
          incremental: true,
          phases: ['_phase:test-prepare', '_phase:test', '_phase:consume']
        }
      ],
      phases: [
        { name: '_phase:test-prepare', missingScriptBehavior: 'silent' },
        { name: '_phase:test', dependencies: { self: ['_phase:test-prepare'] } },
        { name: '_phase:consume', dependencies: { self: ['_phase:test'] }, missingScriptBehavior: 'silent' }
      ],
      parameters: [
        {
          parameterKind: 'string',
          longName: '--drop-graph',
          argumentName: 'FILE',
          description: 'Export a configured graph instead of executing it.',
          associatedCommands: ['test-shards']
        }
      ]
    });
    const autoinstallerFolder: string = path.join(this.folder, 'common', 'autoinstallers', 'shard-identity');
    save('common/autoinstallers/shard-identity/package.json', {
      name: 'shard-identity',
      version: '1.0.0',
      private: true,
      dependencies: {
        [PLUGIN_PACKAGE_NAME]: `file:${path
          .relative(autoinstallerFolder, identityArchivePath)
          .replace(/\\/g, '/')}`,
        [GRAPH_PLUGIN_PACKAGE]: `file:${path.relative(autoinstallerFolder, graphArchivePath).replace(/\\/g, '/')}`
      }
    });
    save('common/config/rush/rush-plugins.json', {
      plugins: [
        {
          packageName: PLUGIN_PACKAGE_NAME,
          pluginName: PLUGIN_NAME,
          autoinstallerName: 'shard-identity'
        },
        {
          packageName: GRAPH_PLUGIN_PACKAGE,
          pluginName: GRAPH_PLUGIN_NAME,
          autoinstallerName: 'shard-identity'
        }
      ]
    });
    save(`common/config/rush-plugins/${PLUGIN_NAME}.json`, { phaseNames: ['_phase:test'] });
    save(`common/config/rush-plugins/${GRAPH_PLUGIN_NAME}.json`, { buildXLCommandNames: ['test-shards'] });

    const heftCommand: string = `node "${this.heftStart}"`;
    this.json('package.json', {
      name: 'app',
      version: '1.0.0',
      scripts: {
        '_phase:test-prepare': `${heftCommand} run --only test-prepare -- --clean`,
        '_phase:test:shard': `${heftCommand} run --only test-shard --`,
        '_phase:test': `${heftCommand} run --only test-collate --`,
        '_phase:consume': `${heftCommand} run --only consume --`
      }
    });
    save('projects/ordinary/package.json', {
      name: 'ordinary',
      version: '1.0.0',
      scripts: { '_phase:test': `${heftCommand} run --only test --` }
    });
    save('projects/ordinary/config/heft.json', {
      phasesByName: {
        test: {
          tasksByName: {
            jest: {
              taskPlugin: { pluginPackage: '@rushstack/heft-jest-plugin' }
            }
          }
        }
      }
    });
    save('projects/ordinary/config/jest.config.json', {
      testEnvironment: require.resolve('jest-environment-node'),
      testMatch: ['<rootDir>/*.test.js'],
      transform: {}
    });
    fs.writeFileSync(
      path.join(this.folder, 'projects', 'ordinary', 'ordinary.test.js'),
      "test('ordinary has no managed identity', () => expect(process.env.RUSH_SHARD_GENERATION).toBeUndefined());"
    );
    save('projects/ordinary/config/rush-project.json', {
      operationSettings: [{ operationName: '_phase:test', disableBuildCacheForOperation: true }]
    });
    this.json('fixture-plugin/package.json', { name: 'fixture-plugin', version: '1.0.0' });
    this.json('fixture-plugin/heft-plugin.json', {
      taskPlugins: [{ pluginName: 'observe', entryPoint: './fixture-task.cjs' }]
    });
    fs.copyFileSync(
      path.join(PACKAGE_FOLDER, 'fixtures', 'fixture-task.cjs'),
      path.join(this.project, 'fixture-plugin', 'fixture-task.cjs')
    );
    fs.copyFileSync(
      path.join(PACKAGE_FOLDER, 'fixtures', 'observe.cjs'),
      path.join(this.project, 'observe.cjs')
    );
    this.write('unsafe-reporter.cjs', 'module.exports = class UnsafeReporter {};');
    this.json('config/heft.json', {
      phasesByName: {
        'test-prepare': {
          cleanFiles: this._cleanFolders('temp', ['shards', 'collated', 'test-shard', 'downstream']),
          tasksByName: { observe: this._observer('prepare') }
        },
        'test-shard': {
          phaseDependencies: ['test-prepare'],
          tasksByName: { jest: { taskPlugin: { pluginPackage: '@rushstack/heft-jest-plugin' } } }
        },
        'test-collate': {
          tasksByName: {
            observe: this._observer('before-collate'),
            collate: {
              taskDependencies: ['observe'],
              taskPlugin: {
                pluginPackage: '@rushstack/heft-jest-plugin',
                pluginName: 'jest-collator-plugin',
                options: { outputDirectory: 'temp/collated', junitOutputFile: 'temp/collated/JUnit.xml' }
              }
            }
          }
        },
        consume: {
          tasksByName: {
            copy: {
              taskPlugin: {
                pluginPackage: '@rushstack/heft',
                pluginName: 'copy-files-plugin',
                options: {
                  copyOperations: [
                    {
                      sourcePath: 'temp/collated',
                      destinationFolders: ['temp/downstream'],
                      includeGlobs: ['**/*']
                    }
                  ]
                }
              }
            }
          }
        }
      }
    });
    await this.resetAsync();
    const git: ICliResult = await this.runAsync('git', ['init', '--quiet']);
    if (git.code) throw new Error(git.output);
    // Rush's Git.isPathUnderGitWorkingTree requires a HEAD SHA, even though input hashing uses
    // the index. Only this disposable nested repository gets an empty commit; no source is committed.
    const emptyHead: ICliResult = await this.runAsync('git', [
      '-c',
      'user.name=Sharding fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=.git/no-hooks',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Initialize disposable integration repository\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
    ]);
    if (emptyHead.code) throw new Error(emptyHead.output);
    // Normal Rush installation creates autoinstaller metadata, lockfiles and install state.
    // All nested dependencies are local links; no fabricated installation/cache success flags.
    const update: ICliResult = await this.runAsync(process.execPath, [
      this._rushStart,
      'update-autoinstaller',
      '--name',
      'shard-identity'
    ]);
    if (update.code) throw new Error(update.output);
    const install: ICliResult = await this.runAsync(process.execPath, [
      this._rushStart,
      'update',
      '--bypass-policy'
    ]);
    if (install.code) throw new Error(install.output);
    // Rush update owns node_modules. Install the already-built test dependencies after it completes.
    this._linkFixtureDependencies();
    await this.trackAsync();
  }

  private async _packPluginAsync(packageName: string): Promise<string> {
    const pluginFolder: string = path.dirname(require.resolve(`${packageName}/package.json`));
    const releaseFolder: string = path.join(
      PACKAGE_FOLDER,
      'temp',
      'release-pack',
      path.basename(pluginFolder)
    );
    fs.rmSync(releaseFolder, { recursive: true, force: true });
    fs.mkdirSync(releaseFolder, { recursive: true });
    const result: ICliResult = await this.runAsync(
      process.execPath,
      [RUSH_PNPM_SCRIPT, 'pack', '--pack-destination', releaseFolder],
      pluginFolder
    );
    if (result.code) {
      throw new Error(result.output);
    }
    const archives: string[] = fs
      .readdirSync(releaseFolder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => path.join(releaseFolder, entry.name));
    if (archives.length !== 1) {
      throw new Error(`Expected one packed ${packageName} archive, received ${archives.length}.`);
    }
    return archives[0];
  }

  private _linkFixtureDependencies(): void {
    for (const project of ['app', 'ordinary']) {
      for (const name of PACKAGE_NAMES) {
        const destination: string = path.join(this.folder, 'projects', project, 'node_modules', name);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(path.dirname(require.resolve(`${name}/package.json`)), destination, 'junction');
      }
    }
    const fixturePlugin: string = path.join(this.project, 'node_modules', 'fixture-plugin');
    fs.rmSync(fixturePlugin, { recursive: true, force: true });
    fs.symlinkSync(path.join(this.project, 'fixture-plugin'), fixturePlugin, 'junction');
  }

  private _observer(action: string): object {
    return { taskPlugin: { pluginPackage: 'fixture-plugin', pluginName: 'observe', options: { action } } };
  }

  private _cleanFolders(sourcePath: string, includeGlobs: string[]): object[] {
    // Select each root once. An implicit **/* also selects its descendants, which Heft
    // recursively deletes concurrently with the ancestor and can fail with EPERM on Windows.
    return [{ sourcePath, includeGlobs }];
  }

  public async resetAsync(options: IFixtureOptions = {}): Promise<void> {
    if (this._activeInvocations !== 0) {
      throw new Error('Cannot reset the sharding fixture while an invocation is still running.');
    }
    await this.restoreMatrixAsync();
    this.remove('tests');
    this.remove('temp');
    // Fault cases can leave claims behind. Only this stopped, disposable fixture owns this cleanup.
    this.remove(SHARD_OUTPUT_OWNERSHIP_FOLDER_NAME);
    fs.rmSync(this.cache, { recursive: true, force: true });
    this.setCount(options.count ?? 2, options.dependsOnEnvVars);
    this.write('source.js', fs.readFileSync(path.join(PACKAGE_FOLDER, 'fixtures', 'source.js'), 'utf8'));
    const bodies: string[] = options.testBodies ?? [
      "test('yes one', () => expect(require('../source')(true)).toBe('yes'));",
      "test('no two', () => expect(require('../source')(false)).toBe('no'));",
      "test('yes three', () => expect(require('../source')(true)).toBe('yes'));",
      "test('no four', () => expect(require('../source')(false)).toBe('no'));"
    ];
    bodies.forEach((body, index) => this.write(`tests/${index + 1}.test.js`, body));
    this.json('config/jest.config.json', {
      testEnvironment: require.resolve('jest-environment-node'),
      testMatch: ['<rootDir>/tests/*.test.js'],
      transform: {},
      setupFilesAfterEnv: ['<rootDir>/observe.cjs'],
      maxWorkers: 1,
      collectCoverage: options.coverage !== false,
      coverageProvider: options.provider ?? 'v8',
      collectCoverageFrom: ['source.js'],
      coverageReporters: ['json', 'lcovonly'],
      coverageThreshold: { global: { branches: options.threshold ?? 100 } },
      ...options.jestOptions
    });
  }

  public setCount(count: number, dependsOnEnvVars: string[] = ['FIXTURE_TEST_MODE']): void {
    this.json('config/rush-project.json', {
      operationSettings: [
        { operationName: '_phase:test-prepare', disableBuildCacheForOperation: true },
        {
          operationName: '_phase:test',
          outputFolderNames: ['temp/collated'],
          dependsOnEnvVars,
          sharding: {
            count,
            outputFolderArgumentFormat: '--shard-output-directory=temp/shards/{shardIndex}'
          }
        },
        { operationName: '_phase:test:shard', weight: 1 },
        {
          operationName: '_phase:consume',
          disableBuildCacheForOperation: true,
          outputFolderNames: ['temp/downstream']
        }
      ]
    });
  }

  public archives(): string[] {
    if (!fs.existsSync(this.cache)) return [];
    return fs
      .readdirSync(this.cache, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }

  public async restoreMatrixAsync(): Promise<void> {
    if (this._activeInvocations !== 0) throw new Error('Cannot restore an active native fixture.');
    if (this._matrixProjects.size === 0) return;
    for (const [filename, content] of this._matrixOriginalFiles) fs.writeFileSync(filename, content);
    this._matrixOriginalFiles.clear();
    for (const project of this._matrixProjects) fs.rmSync(project, { recursive: true, force: true });
    this._matrixProjects.clear();
    // Matrix setup performs a real Rush update. Reconcile the restored project list, lockfile,
    // dependency snapshots and common/temp links before this reusable fixture runs again.
    const install: ICliResult = await this.runAsync(process.execPath, [
      this._rushStart,
      'update',
      '--bypass-policy'
    ]);
    if (install.code) throw new Error(install.output);
    this._linkFixtureDependencies();
  }

  public clearGroupOutputs(groups: Iterable<IManagedGroup>): void {
    for (const group of groups) {
      for (const folder of [group.shardFolder, group.outputFolder, group.downstreamFolder]) {
        fs.rmSync(path.join(group.projectFolder, folder), { recursive: true, force: true });
      }
    }
  }

  public setGroupCount(group: IManagedGroup, count: number): void {
    const config: _IRushProjectJson = this.read('config/rush-project.json', group);
    config.operationSettings!.find(
      (settings) => settings.operationName === group.rushPhaseName
    )!.sharding!.count = count;
    this.json('config/rush-project.json', config, group);
  }

  public renameMatrixProject(groups: Iterable<IManagedGroup>, oldName: string, newName: string): void {
    const filename: string = path.join(this.folder, 'rush.json');
    const configuration: IFixtureRushConfiguration = JSON.parse(
      fs.readFileSync(filename, 'utf8')
    ) as IFixtureRushConfiguration;
    const project: IFixtureProject = configuration.projects.find((item) => item.packageName === oldName)!;
    project.packageName = newName;
    fs.writeFileSync(filename, JSON.stringify(configuration));
    const packagePath: string = path.join(this.folder, project.projectFolder, 'package.json');
    const packageJson: IFixturePackageJson = JSON.parse(
      fs.readFileSync(packagePath, 'utf8')
    ) as IFixturePackageJson;
    packageJson.name = newName;
    fs.writeFileSync(packagePath, JSON.stringify(packageJson));
    for (const group of groups) {
      if (group.projectName === oldName) group.projectName = newName;
    }
  }

  public renameMatrixPhase(group: IManagedGroup, newPhaseName: string): void {
    const oldName: string = group.rushPhaseName;
    const newName: string = `_phase:${newPhaseName}`;
    const commandPath: string = path.join(this.folder, 'common', 'config', 'rush', 'command-line.json');
    const commands: IFixtureCommandLine = JSON.parse(
      fs.readFileSync(commandPath, 'utf8')
    ) as IFixtureCommandLine;
    commands.phases.push(
      { name: `${newName}-prepare`, missingScriptBehavior: 'silent' },
      { name: newName, dependencies: { self: [`${newName}-prepare`] }, missingScriptBehavior: 'silent' },
      { name: `${newName}-consume`, dependencies: { self: [newName] }, missingScriptBehavior: 'silent' }
    );
    commands.commands[0].phases.push(`${newName}-prepare`, newName, `${newName}-consume`);
    fs.writeFileSync(commandPath, JSON.stringify(commands));
    const pluginPath: string = path.join(
      this.folder,
      'common',
      'config',
      'rush-plugins',
      `${PLUGIN_NAME}.json`
    );
    const pluginOptions: IFixtureIdentityOptions = JSON.parse(
      fs.readFileSync(pluginPath, 'utf8')
    ) as IFixtureIdentityOptions;
    pluginOptions.phaseNames.push(newName);
    fs.writeFileSync(pluginPath, JSON.stringify(pluginOptions));
    const packageJson: IFixturePackageJson = this.read('package.json', group);
    const scripts: Record<string, string> = Object.create(null);
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      scripts[name.replace(oldName, newName)] = command;
    }
    this.json('package.json', { ...packageJson, scripts }, group);
    const config: _IRushProjectJson = this.read('config/rush-project.json', group);
    for (const operation of config.operationSettings!) {
      operation.operationName = operation.operationName.replace(oldName, newName);
    }
    this.json('config/rush-project.json', config, group);
    group.rushPhaseName = newName;
  }

  public async configureMatrixAsync(options: IMatrixOptions): Promise<IManagedGroup[]> {
    if (this._activeInvocations !== 0 || this._matrixProjects.size !== 0) {
      throw new Error('The stopped native fixture must be reset before configuring a matrix.');
    }
    const saveRoot = (relative: string, value: unknown): void => {
      const filename: string = path.join(this.folder, relative);
      this._matrixOriginalFiles.set(filename, fs.readFileSync(filename, 'utf8'));
      fs.writeFileSync(filename, JSON.stringify(value));
    };
    const phases: object[] = [{ name: '_phase:test', missingScriptBehavior: 'silent' }];
    const selectedPhases: string[] = ['_phase:test'];
    for (const phase of options.phases) {
      phases.push(
        { name: `_phase:${phase}-prepare`, missingScriptBehavior: 'silent' },
        {
          name: `_phase:${phase}`,
          dependencies: { self: [`_phase:${phase}-prepare`] },
          missingScriptBehavior: 'silent'
        },
        {
          name: `_phase:${phase}-consume`,
          dependencies: { self: [`_phase:${phase}`] },
          missingScriptBehavior: 'silent'
        }
      );
      selectedPhases.push(`_phase:${phase}-prepare`, `_phase:${phase}`, `_phase:${phase}-consume`);
    }
    saveRoot('rush.json', {
      rushVersion: '5.179.0',
      pnpmVersion: '10.27.0',
      telemetryEnabled: false,
      projects: [
        { packageName: 'ordinary', projectFolder: 'projects/ordinary' },
        ...options.projects.map((project) => ({ packageName: project, projectFolder: `projects/${project}` }))
      ]
    });
    saveRoot('common/config/rush/command-line.json', {
      commands: [
        {
          commandKind: 'phased',
          name: 'test-shards',
          summary: 'Independent managed groups',
          enableParallelism: true,
          incremental: true,
          phases: selectedPhases
        }
      ],
      phases
    });
    saveRoot(`common/config/rush-plugins/${PLUGIN_NAME}.json`, {
      phaseNames: options.phases.map((phase) => `_phase:${phase}`)
    });
    saveRoot('common/config/rush/build-cache.json', {
      buildCacheEnabled: true,
      cacheProvider: 'local-only',
      cacheEntryNamePattern: '[projectName]_[phaseName:normalize]_[hash]'
    });
    const groups: IManagedGroup[] = [];
    const heftCommand: string = `node "${this.heftStart}" run --only`;
    for (const projectName of options.projects) {
      const projectFolder: string = path.join(this.folder, 'projects', projectName);
      if (fs.existsSync(projectFolder)) throw new Error(`Matrix project already exists: ${projectFolder}`);
      this._matrixProjects.add(projectFolder);
      const scripts: Record<string, string> = Object.create(null);
      const phasesByName: Record<string, object> = Object.create(null);
      const operationSettings: NonNullable<_IRushProjectJson['operationSettings']> = [];
      for (const phaseName of options.phases) {
        const group: IManagedGroup = {
          projectName,
          phaseName,
          rushPhaseName: `_phase:${phaseName}`,
          projectFolder,
          shardFolder: `temp/${phaseName}/shards`,
          outputFolder: `temp/${phaseName}/collated`,
          downstreamFolder: `temp/${phaseName}/downstream`,
          environmentName: `FIXTURE_${projectName}_${phaseName}`.toUpperCase().replace(/-/g, '_')
        };
        groups.push(group);
        scripts[`_phase:${phaseName}-prepare`] = `${heftCommand} ${phaseName}-prepare -- --clean`;
        scripts[`_phase:${phaseName}:shard`] =
          `${heftCommand} ${phaseName}-shard -- --config config/${phaseName}.jest.json`;
        scripts[`_phase:${phaseName}`] = `${heftCommand} ${phaseName}-collate --`;
        scripts[`_phase:${phaseName}-consume`] = `${heftCommand} ${phaseName}-consume --`;
        operationSettings.push(
          { operationName: `_phase:${phaseName}-prepare`, disableBuildCacheForOperation: true },
          {
            operationName: `_phase:${phaseName}`,
            outputFolderNames: [group.outputFolder],
            dependsOnEnvVars: [group.environmentName],
            sharding: {
              count: 2,
              outputFolderArgumentFormat: `--shard-output-directory=${group.shardFolder}/{shardIndex}`
            }
          },
          { operationName: `_phase:${phaseName}:shard`, weight: 1 },
          {
            operationName: `_phase:${phaseName}-consume`,
            disableBuildCacheForOperation: true,
            outputFolderNames: [group.downstreamFolder]
          }
        );
        phasesByName[`${phaseName}-prepare`] = {
          cleanFiles: this._cleanFolders('temp', [
            `${phaseName}/shards`,
            `${phaseName}/collated`,
            `${phaseName}/downstream`,
            `${phaseName}-shard`
          ]),
          tasksByName: { observe: this._observer(`${phaseName}-prepare`) }
        };
        phasesByName[`${phaseName}-shard`] = {
          tasksByName: { jest: { taskPlugin: { pluginPackage: '@rushstack/heft-jest-plugin' } } }
        };
        phasesByName[`${phaseName}-collate`] = {
          tasksByName: {
            observe: this._observer(`${phaseName}-collate`),
            collate: {
              taskDependencies: ['observe'],
              taskPlugin: {
                pluginPackage: '@rushstack/heft-jest-plugin',
                pluginName: 'jest-collator-plugin',
                options: { outputDirectory: group.outputFolder }
              }
            }
          }
        };
        phasesByName[`${phaseName}-consume`] = {
          tasksByName: {
            copy: {
              taskPlugin: {
                pluginPackage: '@rushstack/heft',
                pluginName: 'copy-files-plugin',
                options: {
                  copyOperations: [
                    {
                      sourcePath: group.outputFolder,
                      destinationFolders: [group.downstreamFolder],
                      includeGlobs: ['**/*']
                    }
                  ]
                }
              }
            }
          }
        };
        this.json(
          `config/${phaseName}.jest.json`,
          {
            testEnvironment: require.resolve('jest-environment-node'),
            testMatch: [`<rootDir>/tests/${phaseName}/*.test.js`],
            transform: {},
            maxWorkers: 1,
            setupFilesAfterEnv: [`<rootDir>/${phaseName}-observe.cjs`],
            collectCoverage: true,
            coverageProvider: 'v8',
            collectCoverageFrom: ['source.js'],
            coverageReporters: ['json', 'lcovonly'],
            coverageThreshold: { global: { branches: 100 } }
          },
          group
        );
        this.write(
          `${phaseName}-observe.cjs`,
          `const fs = require('node:fs'); const path = require('node:path');\n` +
            `const folder = path.join(process.cwd(), 'temp', 'instrumentation');\n` +
            `fs.mkdirSync(folder, { recursive: true });\n` +
            `fs.appendFileSync(path.join(folder, '${phaseName}-suites.jsonl'), JSON.stringify(expect.getState().testPath) + '\\n');\n`,
          group
        );
        for (let index: number = 1; index <= 2; index++) {
          this.write(
            `tests/${phaseName}/${index}.test.js`,
            `test('partition ${index}', () => {\n` +
              `expect(require('../../source')(${index === 1})).toBe('${index === 1 ? 'yes' : 'no'}');\n` +
              `expect(process.env.${group.environmentName}).not.toBe('fail');\n});\n`,
            group
          );
        }
      }
      const group: IManagedGroup = groups[groups.length - 1];
      this.json('package.json', { name: projectName, version: '1.0.0', scripts }, group);
      this.json('config/heft.json', { phasesByName }, group);
      this.json('config/rush-project.json', { operationSettings }, group);
      this.write(
        'source.js',
        fs.readFileSync(path.join(PACKAGE_FOLDER, 'fixtures', 'source.js'), 'utf8'),
        group
      );
    }
    // New project manifests need Rush's real dependency snapshots even with no external dependencies.
    // Do not synthesize shrinkwrap-deps.json or install flags for the added projects.
    const install: ICliResult = await this.runAsync(process.execPath, [
      this._rushStart,
      'update',
      '--bypass-policy'
    ]);
    if (install.code) throw new Error(install.output);
    for (const projectFolder of this._matrixProjects) {
      for (const name of [...PACKAGE_NAMES, 'fixture-plugin']) {
        const destination: string = path.join(projectFolder, 'node_modules', name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(
          fs.realpathSync(path.join(this.project, 'node_modules', name)),
          destination,
          'junction'
        );
      }
    }
    await this.trackAsync();
    return groups;
  }
}
