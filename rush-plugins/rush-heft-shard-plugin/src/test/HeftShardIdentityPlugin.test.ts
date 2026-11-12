// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { inc } from 'semver';
import { Rush, RushSession } from '@microsoft/rush-lib';
import { StringBufferTerminalProvider } from '@rushstack/terminal';
import type { HeftShardIdentityPlugin } from '../HeftShardIdentityPlugin';
import { Operation } from '@microsoft/rush-lib/lib/logic/operations/Operation';
import { OperationStatus } from '@microsoft/rush-lib/lib/logic/operations/OperationStatus';
import {
  createFixtureAsync,
  environmentFor,
  executeWithoutShellAsync,
  planAsync,
  prepareShellExecution,
  WORK_FOLDER,
  type IFixtureOptions
} from './RushFixture';

const PACKAGE_VERSION: string = (require('../../package.json') as { version: string }).version;
const NEXT_PATCH_VERSION: string = inc(PACKAGE_VERSION, 'patch')!;

describe('Rush Heft shard identity', () => {
  let Plugin: typeof HeftShardIdentityPlugin;
  beforeAll(async () => {
    // Let the real loader bind the SDK to this host before importing the plugin, just as in Rush.
    // Importing it at test-module scope could instead pick up the outer rushx bootstrap engine.
    await createFixtureAsync();
    Plugin = (await import('../HeftShardIdentityPlugin')).HeftShardIdentityPlugin;
  });

  afterAll(() => {
    fs.rmSync(WORK_FOLDER, { recursive: true, force: true });
  });

  it.each(['0.0.0', NEXT_PATCH_VERSION, '6.0.0', 'invalid', '', `${PACKAGE_VERSION}-beta.1`])(
    'rejects unsupported public host version %j before registering hooks',
    (version) => {
      const session: RushSession = new RushSession({
        terminalProvider: new StringBufferTerminalProvider(),
        getIsDebugMode: () => false
      });
      const versionSpy = jest.spyOn(Rush, 'version', 'get').mockReturnValue(version);
      try {
        expect(() => new Plugin({ phaseNames: ['_phase:test'] }).apply(session)).toThrow(
          `Unsupported Rush host version "${version}"`
        );
        expect(session.hooks.runAnyPhasedCommand.taps).toHaveLength(0);
      } finally {
        versionSpy.mockRestore();
      }
    }
  );

  it.each([PACKAGE_VERSION, `${PACKAGE_VERSION}+workspace`])(
    'accepts supported public host version %j',
    (version) => {
      const session: RushSession = new RushSession({
        terminalProvider: new StringBufferTerminalProvider(),
        getIsDebugMode: () => false
      });
      const versionSpy = jest.spyOn(Rush, 'version', 'get').mockReturnValue(version);
      try {
        expect(() => new Plugin({ phaseNames: ['_phase:test'] }).apply(session)).not.toThrow();
      } finally {
        versionSpy.mockRestore();
      }
    }
  );

  it.each(['0.0.0', NEXT_PATCH_VERSION])(
    'rejects an incompatible host through the actual autoinstaller entry (%s)',
    async (version) => {
      const versionSpy = jest.spyOn(Rush, 'version', 'get');
      try {
        await expect(
          createFixtureAsync({
            beforePluginLoad: () => {
              versionSpy.mockReturnValue(version);
            }
          })
        ).rejects.toThrow(`Unsupported Rush host version "${version}"`);
      } finally {
        versionSpy.mockRestore();
      }
    }
  );

  it('loads through the autoinstaller manifest and injects into every native shard and the collator', async () => {
    const fixture = await createFixtureAsync({ buildCacheEnabled: true });
    const run = await planAsync(fixture);
    expect(run.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.shards).toHaveLength(2);
    expect(fixture.collator.runner!.cacheable).toBe(false);
    for (const shard of fixture.shards) {
      expect(shard.runner!.cacheable).toBe(true);
      expect(shard.runner!.warningsAreAllowed).toBe(true);
      expect(shard.associatedPhase).toBe(fixture.collator.associatedPhase);
      expect(shard.dependencies).toEqual(new Set([fixture.preShard]));
      expect(environmentFor(run.records.get(shard)!).RUSH_SHARD_GENERATION).toBe(run.generation);
    }
    expect(fixture.collator.dependencies).toEqual(new Set(fixture.shards));
    expect(environmentFor(run.records.get(fixture.preShard!)!).RUSH_SHARD_GENERATION).toBe(
      process.env.RUSH_SHARD_GENERATION
    );
    expect(run.shardHashes[0]).not.toBe(run.shardHashes[1]);
  });

  it('exports the native generation without local environment hooks or legacy cache exclusions', async () => {
    const fixture = await createFixtureAsync({ buildCacheEnabled: false });
    const localEnvironment = jest.fn((environment) => environment);
    fixture.graph.hooks.createEnvironmentForOperation.tap('local-secret', localEnvironment);
    const records = await fixture.graph.createExecutionPlanAsync({ inputsSnapshot: fixture.snapshot() });
    const generation = records.get(fixture.collator)!.environmentOverrides?.RUSH_SHARD_GENERATION;
    expect(generation).toMatch(/^[a-f0-9]{64}$/);
    expect(localEnvironment).not.toHaveBeenCalled();
    expect(fixture.graph.hasScheduledIteration).toBe(false);
    expect(fixture.collator.runner!.cacheable).toBe(false);
    for (const shard of fixture.shards) {
      expect(shard.runner!.cacheable).toBe(true);
      expect(records.get(shard)!.environmentOverrides).toEqual({ RUSH_SHARD_GENERATION: generation });
    }
    const native = await planAsync(fixture);
    expect(native.generation).toBe(generation);
  });

  it('is deterministic on reruns and independent of graph and sibling enumeration order', async () => {
    const first = await planAsync(await createFixtureAsync());
    const second = await planAsync(
      await createFixtureAsync({
        mutateOperations: (operations) => {
          const reversed: Operation[] = [...operations].reverse();
          operations.clear();
          for (const operation of reversed) {
            operations.add(operation);
            const dependencies: Operation[] = [...operation.dependencies].reverse();
            for (const dependency of dependencies) {
              operation.deleteDependency(dependency);
              operation.addDependency(dependency);
            }
          }
        }
      })
    );
    expect(second.generation).toBe(first.generation);
    expect(second.shardHashes.sort()).toEqual(first.shardHashes.sort());
  });

  it('supplies the current collator token even when ALL shards bypass environment creation as cache hits', async () => {
    const cold = await createFixtureAsync();
    const coldEnvironments = await executeWithoutShellAsync(cold, OperationStatus.Success);
    const warm = await createFixtureAsync();
    const warmEnvironments = await executeWithoutShellAsync(warm, OperationStatus.FromCache);
    expect(warmEnvironments.get(warm.collator)).toBe(coldEnvironments.get(cold.collator));
    expect(warmEnvironments.get(warm.collator)).toMatch(/^[a-f0-9]{64}$/);
    for (const shard of warm.shards) {
      expect(warmEnvironments.has(shard)).toBe(false);
    }
  });

  it.each(['source', 'upstream', 'environment'] as const)(
    'invalidates current and cache identities for changed %s',
    async (input) => {
      const fixture = await createFixtureAsync();
      const original = await planAsync(fixture);
      const changed = await planAsync(
        fixture,
        input === 'environment' ? { environment: { TEST_MODE: 'coverage' } } : { [input]: 'changed input' }
      );
      expect(changed.generation).not.toBe(original.generation);
      for (let i: number = 0; i < fixture.shards.length; i++) {
        expect(changed.shardHashes[i]).not.toBe(original.shardHashes[i]);
      }
      // Configuring another iteration cannot overwrite the token of an already-created record.
      expect(environmentFor(original.records.get(fixture.collator)!).RUSH_SHARD_GENERATION).toBe(
        original.generation
      );
    }
  );

  it.each<IFixtureOptions>([
    { filter: 'specific-test' },
    { count: 1 },
    { count: 3 },
    { collatorCommand: 'node collate.js --coverage' },
    { phaseName: '_phase:verify' },
    { packageName: 'other-app' }
  ])('invalidates for changed shared configuration or domain: %j', async (options) => {
    const original = await planAsync(await createFixtureAsync());
    const changed = await planAsync(await createFixtureAsync(options));
    expect(changed.generation).not.toBe(original.generation);
    const oldHashes: Set<string> = new Set(original.shardHashes);
    for (const hash of changed.shardHashes) {
      expect(oldHashes.has(hash)).toBe(false);
    }
  });

  it('binds a change to ONE sibling configuration into EVERY sibling cache key before hashing', async () => {
    const original = await planAsync(await createFixtureAsync());
    const changed = await planAsync(
      await createFixtureAsync({
        mutateOperations: (operations) => {
          for (const operation of operations) {
            if (operation.settings?.operationName === '_phase:test:shard') {
              const originalConfig: string = operation.runner!.getConfigHash();
              operation.runner!.getConfigHash = () => `${originalConfig} --different-selection`;
              break;
            }
          }
        }
      })
    );
    expect(changed.generation).not.toBe(original.generation);
    const oldHashes: Set<string> = new Set(original.shardHashes);
    expect(changed.shardHashes.every((hash) => !oldHashes.has(hash))).toBe(true);
  });

  it.each(['shard', 'collator'] as const)(
    'reads current %s configuration from a later graph hook before native hashing',
    async (target) => {
      const original = await planAsync(await createFixtureAsync());
      const fixture = await createFixtureAsync({
        configureHooks: (hooks) => {
          hooks.onGraphCreatedAsync.tap(
            { name: 'later-configuration-plugin', stage: Number.MAX_SAFE_INTEGER },
            (graph) => {
              for (const operation of graph.operations) {
                if (
                  target === 'shard'
                    ? operation.settings?.operationName === '_phase:test:shard'
                    : operation.settings?.sharding && !operation.isNoOp
                ) {
                  const runner = operation.runner!;
                  const getConfigHash = runner.getConfigHash.bind(runner);
                  runner.getConfigHash = () => `${getConfigHash()} --later-selection`;
                  break;
                }
              }
            }
          );
        }
      });
      const changed = await planAsync(fixture);
      expect(changed.generation).not.toBe(original.generation);
      const oldHashes: Set<string> = new Set(original.shardHashes);
      expect(changed.shardHashes.every((hash) => !oldHashes.has(hash))).toBe(true);
    }
  );

  it.each(['pre-shard', 'shard', 'collator'] as const)(
    'refreshes current %s configuration across native iterations without changing prior records',
    async (target) => {
      let selection: string = 'first-selection';
      const fixture = await createFixtureAsync({
        mutateOperations: (operations) => {
          for (const operation of operations) {
            if (
              target === 'shard'
                ? operation.settings?.operationName === '_phase:test:shard'
                : operation.settings?.sharding && operation.isNoOp === (target === 'pre-shard')
            ) {
              const runner = operation.runner!;
              const getConfigHash = runner.getConfigHash.bind(runner);
              runner.getConfigHash = () => `${getConfigHash()} ${selection}`;
              break;
            }
          }
        }
      });
      const original = await planAsync(fixture);
      selection = 'second-selection';
      const changed = await planAsync(fixture);
      expect(changed.generation).not.toBe(original.generation);
      const oldHashes: Set<string> = new Set(original.shardHashes);
      expect(changed.shardHashes.every((hash) => !oldHashes.has(hash))).toBe(true);
      expect(environmentFor(original.records.get(fixture.collator)!).RUSH_SHARD_GENERATION).toBe(
        original.generation
      );
      expect(fixture.shards.map((shard) => original.records.get(shard)!.getStateHash())).toEqual(
        original.shardHashes
      );
    }
  );

  it('masks synthetic work when --changed-projects-only disables the logical phase in watch mode', async () => {
    const fixture = await createFixtureAsync({
      changedProjectsOnly: true,
      buildCacheEnabled: true,
      isWatch: true
    });
    prepareShellExecution(fixture);
    const first = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    expect(first.status).toBe(OperationStatus.Success);
    fs.writeFileSync(path.join(fixture.collator.associatedProject.projectFolder, 'diagnostic'), '');
    const second = await fixture.graph.executeAsync({
      inputsSnapshot: fixture.snapshot({ upstream: 'changed upstream' })
    });
    for (const operation of [fixture.collator, ...fixture.shards]) {
      expect(second.operationResults.get(operation)!.enabled).toBe(false);
      expect(second.operationResults.get(operation)!.status).toBe(OperationStatus.Skipped);
    }
    expect(second.operationResults.get(fixture.preShard!)!.enabled).toBe(false);
    expect(fixture.collator.enabled).toBe('ignore-dependency-changes');
    for (const operation of [fixture.preShard!, ...fixture.shards]) {
      expect(operation.enabled).toBe(true);
    }
    expect(second.status).toBe(OperationStatus.Success);
    const ordinaryBuild = [...fixture.graph.operations].find(
      (operation) =>
        operation.associatedProject === fixture.collator.associatedProject &&
        operation.associatedPhase.name === '_phase:build'
    )!;
    expect(second.operationResults.get(ordinaryBuild)!.enabled).toBe(false);
    expect(second.operationResults.get(ordinaryBuild)!.status).toBe(OperationStatus.Skipped);
  });

  it('masks synthetic work after late collator iteration decisions without changing ordinary operations', async () => {
    const fixture = await createFixtureAsync({
      configureHooks: (hooks) => {
        hooks.onGraphCreatedAsync.tap('late-iteration-plugin', (graph) => {
          graph.hooks.configureIteration.tap({ name: 'late-iteration-plugin', stage: 10000 }, (records) => {
            for (const [operation, record] of records) {
              if (operation.settings?.sharding && !operation.isNoOp) {
                record.enabled = false;
              }
            }
          });
        });
      }
    });
    prepareShellExecution(fixture);
    fs.writeFileSync(path.join(fixture.collator.associatedProject.projectFolder, 'diagnostic'), '');
    const result = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    for (const operation of [fixture.collator, ...fixture.shards]) {
      expect(result.operationResults.get(operation)!.status).toBe(OperationStatus.Skipped);
      expect(result.operationResults.get(operation)!.enabled).toBe(false);
      expect(operation.enabled).toBe(true);
    }
    expect(result.status).toBe(OperationStatus.Success);
  });

  it.each(['selection', 'iteration'] as const)('preserves whole-group %s exclusions', async (exclusion) => {
    const fixture = await createFixtureAsync({
      mutateOperations: (operations) => {
        if (exclusion === 'selection') {
          for (const operation of operations) {
            if (operation.associatedPhase.name === '_phase:test') operation.enabled = false;
          }
        }
      },
      configureHooks: (hooks) => {
        if (exclusion === 'iteration') {
          hooks.onGraphCreatedAsync.tap('exclude-group', (graph) => {
            graph.hooks.configureIteration.tap({ name: 'exclude-group', stage: 10000 }, (records) => {
              for (const [operation, record] of records) {
                if (operation.associatedPhase.name === '_phase:test') record.enabled = false;
              }
            });
          });
        }
      }
    });
    prepareShellExecution(fixture);
    const result = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    expect(result.status).toBe(OperationStatus.Success);
    for (const operation of [fixture.collator, ...fixture.shards]) {
      const record = result.operationResults.get(operation)!;
      expect(record.enabled).toBe(false);
      expect(record.status).toBe(OperationStatus.Skipped);
    }
    for (const [operation, record] of result.operationResults) {
      if (operation.associatedPhase.name === '_phase:build') {
        expect(record.enabled).toBe(true);
        expect(record.status).toBe(OperationStatus.Success);
      }
    }
  });

  it('masks synthetic work when the original phase is explicitly excluded', async () => {
    const fixture = await createFixtureAsync({
      mutateOperations: (operations) => {
        for (const operation of operations) {
          if (operation.settings?.sharding && !operation.isNoOp) operation.enabled = false;
        }
      }
    });
    prepareShellExecution(fixture);
    const result = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    for (const operation of [fixture.collator, ...fixture.shards]) {
      expect(result.operationResults.get(operation)!.enabled).toBe(false);
      expect(result.operationResults.get(operation)!.status).toBe(OperationStatus.Skipped);
    }
    expect(result.status).toBe(OperationStatus.Success);
  });

  it('fails closed before execution if a later plugin disables only the collator after normalization', async () => {
    const fixture = await createFixtureAsync();
    prepareShellExecution(fixture);
    fixture.graph.hooks.configureIteration.tap(
      { name: 'disable-collator-after-normalization', stage: Number.MAX_SAFE_INTEGER },
      (records) => {
        records.get(fixture.collator)!.enabled = false;
      }
    );
    await expect(fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() })).rejects.toThrow(
      'Cannot execute a managed shard without its current collator.'
    );
    expect(
      fs.existsSync(path.join(fixture.collator.associatedProject.projectFolder, 'manifest-1.json'))
    ).toBe(false);
  });

  it('retains legitimate native shard reuse when retrying an enabled collator', async () => {
    const fixture = await createFixtureAsync();
    prepareShellExecution(fixture);
    fs.appendFileSync(
      path.join(fixture.collator.associatedProject.projectFolder, 'collate.js'),
      '\nprocess.exitCode = 1;\n'
    );
    const first = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    expect(first.status).toBe(OperationStatus.Failure);
    for (const shard of fixture.shards) {
      expect(first.operationResults.get(shard)!.status).toBe(OperationStatus.Success);
    }
    const second = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    for (const shard of fixture.shards) {
      expect(second.operationResults.get(shard)!.enabled).toBe(false);
      expect(second.operationResults.get(shard)!.status).toBe(OperationStatus.Skipped);
    }
    expect(second.operationResults.get(fixture.collator)!.enabled).toBe(true);
    expect(second.operationResults.get(fixture.collator)!.status).toBe(OperationStatus.Failure);
    expect(second.status).toBe(OperationStatus.Failure);
  });

  it('keeps an unchanged native group disabled after successful execution', async () => {
    const fixture = await createFixtureAsync();
    prepareShellExecution(fixture);
    const first = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    expect(first.status).toBe(OperationStatus.Success);
    let configured: boolean = false;
    fixture.graph.hooks.configureIteration.tap(
      { name: 'verify-unchanged-group', stage: Number.MAX_SAFE_INTEGER },
      (records) => {
        configured = true;
        for (const operation of [fixture.preShard!, fixture.collator, ...fixture.shards]) {
          expect(records.get(operation)!.enabled).toBe(false);
        }
      }
    );
    const second = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    expect(configured).toBe(true);
    expect(second.status).toBe(OperationStatus.NoOp);
  });

  it.each([undefined, false])(
    'reruns managed shards instead of legacy-skipping changed declared environment inputs (cache=%s)',
    async (buildCacheEnabled) => {
      const fixture = await createFixtureAsync({ buildCacheEnabled });
      prepareShellExecution(fixture);
      const first = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
      expect(first.status).toBe(OperationStatus.Success);
      const second = await fixture.graph.executeAsync({
        inputsSnapshot: fixture.snapshot({ environment: { TEST_MODE: 'coverage' } })
      });
      for (const shard of fixture.shards) {
        expect(second.operationResults.get(shard)!.status).toBe(OperationStatus.Success);
        expect(shard.runner!.cacheable).toBe(false);
      }
      expect(second.operationResults.get(fixture.collator)!.status).toBe(OperationStatus.Success);
      expect(second.status).toBe(OperationStatus.Success);
      expect(environmentFor(second.operationResults.get(fixture.collator)!).RUSH_SHARD_GENERATION).not.toBe(
        environmentFor(first.operationResults.get(fixture.collator)!).RUSH_SHARD_GENERATION
      );
    }
  );

  it('reruns every shard through native legacy hooks when just one sibling configuration changes', async () => {
    const fixture = await createFixtureAsync();
    prepareShellExecution(fixture);
    const first = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    expect(first.status).toBe(OperationStatus.Success);
    const runner = fixture.shards[0].runner!;
    const getConfigHash = runner.getConfigHash.bind(runner);
    runner.getConfigHash = () => `${getConfigHash()} --new-selection`;
    const second = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    for (const shard of fixture.shards) {
      expect(second.operationResults.get(shard)!.status).toBe(OperationStatus.Success);
    }
    expect(second.operationResults.get(fixture.collator)!.status).toBe(OperationStatus.Success);
    expect(second.status).toBe(OperationStatus.Success);
    expect(environmentFor(second.operationResults.get(fixture.collator)!).RUSH_SHARD_GENERATION).not.toBe(
      environmentFor(first.operationResults.get(fixture.collator)!).RUSH_SHARD_GENERATION
    );
  });

  it('preserves native legacy skipping for ordinary operations', async () => {
    const fixture = await createFixtureAsync({ sharded: false });
    prepareShellExecution(fixture);
    fs.writeFileSync(path.join(fixture.collator.associatedProject.projectFolder, 'collate.js'), '');
    const first = await fixture.graph.executeAsync({ inputsSnapshot: fixture.snapshot() });
    expect(first.status).toBe(OperationStatus.Success);
    const second = await fixture.graph.executeAsync({
      inputsSnapshot: fixture.snapshot({ environment: { TEST_MODE: 'coverage' } })
    });
    expect(second.operationResults.get(fixture.collator)!.enabled).toBe(true);
    expect(second.operationResults.get(fixture.collator)!.status).toBe(OperationStatus.Skipped);
    expect(fixture.collator.runner!.cacheable).toBe(true);
  });

  it('overwrites a caller-supplied token without making it part of the current input identity', async () => {
    const fixture = await createFixtureAsync();
    const previous: string | undefined = process.env.RUSH_SHARD_GENERATION;
    try {
      process.env.RUSH_SHARD_GENERATION = 'spoof-a';
      const first = await planAsync(fixture);
      process.env.RUSH_SHARD_GENERATION = 'spoof-b';
      const second = await planAsync(fixture);
      expect(second.generation).toBe(first.generation);
      expect(second.generation).not.toBe('spoof-a');
      expect(environmentFor(second.records.get(fixture.shards[0])!).RUSH_SHARD_GENERATION).toBe(
        first.generation
      );
      expect(environmentFor(second.records.get(fixture.preShard!)!).RUSH_SHARD_GENERATION).toBe('spoof-b');
    } finally {
      if (previous === undefined) {
        delete process.env.RUSH_SHARD_GENERATION;
      } else {
        process.env.RUSH_SHARD_GENERATION = previous;
      }
    }
  });

  it('includes the actual Node runtime even if the original phase does not opt into Node version hashing', async () => {
    const original = await planAsync(await createFixtureAsync());
    const versionDescriptor: PropertyDescriptor = Object.getOwnPropertyDescriptor(process, 'version')!;
    Object.defineProperty(process, 'version', { ...versionDescriptor, value: 'v22.16.1' });
    try {
      const changed = await planAsync(await createFixtureAsync());
      expect(changed.generation).not.toBe(original.generation);
      const oldHashes: Set<string> = new Set(original.shardHashes);
      expect(changed.shardHashes.every((hash) => !oldHashes.has(hash))).toBe(true);
    } finally {
      Object.defineProperty(process, 'version', versionDescriptor);
    }
  });

  it('does not modify unsharded operation hashes or environments', async () => {
    const enabled = await createFixtureAsync({ sharded: false });
    const disabled = await createFixtureAsync({ sharded: false, enablePlugin: false });
    const withPlugin = await planAsync(enabled);
    const withoutPlugin = await planAsync(disabled);
    expect(withPlugin.generation).toBe(process.env.RUSH_SHARD_GENERATION);
    expect(enabled.collator.runner!.cacheable).toBe(disabled.collator.runner!.cacheable);
    expect(enabled.collator.runner!.warningsAreAllowed).toBe(disabled.collator.runner!.warningsAreAllowed);
    expect(withPlugin.records.get(enabled.collator)!.getStateHash()).toBe(
      withoutPlugin.records.get(disabled.collator)!.getStateHash()
    );
  });

  it('leaves native sharding untouched for phases that are not explicitly selected', async () => {
    const enabled = await createFixtureAsync({ managedPhaseNames: ['_phase:another'] });
    const disabled = await createFixtureAsync({ enablePlugin: false });
    const withPlugin = await planAsync(enabled);
    const withoutPlugin = await planAsync(disabled);
    expect(withPlugin.generation).toBe(process.env.RUSH_SHARD_GENERATION);
    expect(withPlugin.shardHashes).toEqual(withoutPlugin.shardHashes);
  });

  it('does not depend on log filename conventions or parse display names', async () => {
    const fixture = await createFixtureAsync({
      mutateOperations: (operations) => {
        let index: number = 0;
        for (const operation of operations) {
          operation.logFilenameIdentifier = `arbitrary-${index++}`;
        }
      }
    });
    const run = await planAsync(fixture);
    const original = await planAsync(await createFixtureAsync());
    expect(run.generation).toBe(original.generation);
  });

  it.each<IFixtureOptions>([
    { phaseEnvVars: ['RUSH_SHARD_GENERATION'] },
    { shardEnvVars: ['SHARD_ONLY_ENV'] },
    { shardFiles: ['outside-project.txt'] }
  ])('rejects inputs that Rush cannot safely hash for this graph: %j', async (options) => {
    await expect(createFixtureAsync(options)).rejects.toThrow(/derived|original phase/);
  });

  it.each([
    'missing-shard',
    'extra-edge',
    'extra-consumer',
    'second-pre-shard',
    'wrong-operation-name'
  ] as const)('fails closed for ambiguous or malformed topology: %s', async (mutation) => {
    await expect(
      createFixtureAsync({
        mutateOperations: (operations) => {
          const shards: Operation[] = [];
          let preShard: Operation | undefined;
          let collator: Operation | undefined;
          for (const operation of operations) {
            if (operation.settings?.sharding) {
              if (operation.isNoOp) preShard = operation;
              else collator = operation;
            } else if (operation.settings?.operationName === '_phase:test:shard') {
              shards.push(operation);
            }
          }
          switch (mutation) {
            case 'missing-shard':
              collator!.deleteDependency(shards[0]);
              shards[0].deleteDependency(preShard!);
              operations.delete(shards[0]);
              break;
            case 'extra-edge':
              shards[0].addDependency([...preShard!.dependencies][0]);
              break;
            case 'extra-consumer':
              shards[1].addDependency(shards[0]);
              break;
            case 'second-pre-shard':
              operations.add(
                new Operation({
                  phase: preShard!.associatedPhase,
                  project: preShard!.associatedProject,
                  runner: preShard!.runner,
                  settings: preShard!.settings,
                  logFilenameIdentifier: 'extra'
                })
              );
              break;
            case 'wrong-operation-name':
              shards[0].settings = { ...shards[0].settings, operationName: 'wrong' };
              break;
          }
        }
      })
    ).rejects.toThrow('rush-heft-shard-plugin: app (_phase:test):');
  });

  it('fails closed without a current input snapshot, rather than trusting old outputs', async () => {
    const fixture = await createFixtureAsync();
    await expect(fixture.graph.scheduleIterationAsync({})).rejects.toThrow(/without git/);
  });
});
