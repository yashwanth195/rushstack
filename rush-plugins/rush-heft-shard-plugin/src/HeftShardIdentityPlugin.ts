// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { createHash } from 'node:crypto';

import { eq, valid } from 'semver';

import { Rush } from '@rushstack/rush-sdk';
import type {
  IConfigurableOperation,
  IOperationGraph,
  IOperationGraphContext,
  IOperationRunner,
  IRushPlugin,
  Operation,
  RushSession
} from '@microsoft/rush-lib';

const PLUGIN_NAME: string = 'rush-heft-shard-plugin';
const GENERATION_VARIABLE: string = 'RUSH_SHARD_GENERATION';
const IDENTITY_VERSION: string = 'heft-shard-identity-v1';

interface IPackageJson {
  version: string;
}

const packageJson: IPackageJson = require('../package.json');
const SUPPORTED_RUSH_VERSION: string = packageJson.version;

export interface IHeftShardIdentityPluginOptions {
  phaseNames: string[];
}

interface IShardGroup {
  preShard: Operation;
  shards: Operation[];
  collator: Operation;
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fail(operation: Operation, detail: string): never {
  throw new Error(
    `${PLUGIN_NAME}: ${operation.associatedProject.packageName} (${operation.associatedPhase.name}): ${detail}`
  );
}

function findGroups(operations: Iterable<Operation>, phaseNames: ReadonlySet<string>): IShardGroup[] {
  const buckets: Map<string, Operation[]> = new Map();
  for (const operation of operations) {
    const { associatedPhase, associatedProject } = operation;
    if (phaseNames.has(associatedPhase.name)) {
      const key: string = JSON.stringify([associatedProject.packageName, associatedPhase.name]);
      let bucket: Operation[] | undefined = buckets.get(key);
      if (!bucket) {
        buckets.set(key, (bucket = []));
      }
      bucket.push(operation);
    }
  }

  const groups: IShardGroup[] = [];
  for (const bucket of buckets.values()) {
    let preShard: Operation | undefined;
    let collator: Operation | undefined;
    const shards: Operation[] = [];
    for (const operation of bucket) {
      if (operation.settings?.sharding) {
        if (operation.settings.operationName !== operation.associatedPhase.name || !operation.runner) {
          fail(operation, 'Expected native Rush phase sharding settings and an initialized runner.');
        }
        if (operation.isNoOp) {
          if (preShard) {
            fail(operation, 'Ambiguous pre-shard topology.');
          }
          preShard = operation;
        } else {
          if (collator) {
            fail(operation, 'Ambiguous collator topology.');
          }
          collator = operation;
        }
      } else if (operation.settings?.operationName === `${operation.associatedPhase.name}:shard`) {
        shards.push(operation);
      }
    }
    if (!preShard && !collator && shards.length === 0) {
      continue;
    }
    const reference: Operation = bucket[0];
    if (!preShard || !collator) {
      fail(reference, 'Expected one no-op pre-shard node and one executable collator.');
    }
    const count: number = collator.settings!.sharding!.count;
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      preShard.settings!.sharding!.count !== count ||
      shards.length !== count ||
      bucket.length !== count + 2 ||
      preShard.consumers.size !== count ||
      collator.dependencies.size !== count
    ) {
      fail(reference, 'Shard count or native Rush fan-out/fan-in topology does not match configuration.');
    }
    for (const shard of shards) {
      if (
        !shard.runner ||
        shard.isNoOp ||
        shard.associatedProject !== collator.associatedProject ||
        shard.associatedPhase !== collator.associatedPhase ||
        shard.dependencies.size !== 1 ||
        !shard.dependencies.has(preShard) ||
        shard.consumers.size !== 1 ||
        !shard.consumers.has(collator) ||
        !collator.dependencies.has(shard) ||
        !preShard.consumers.has(shard)
      ) {
        fail(
          shard,
          'Expected every shard to depend only on the shared pre-shard node and feed only its collator.'
        );
      }
    }
    if (
      preShard.associatedProject !== collator.associatedProject ||
      preShard.associatedPhase !== collator.associatedPhase
    ) {
      fail(reference, 'Ambiguous project or phase identity.');
    }
    const phaseEnvVars: Set<string> = new Set(collator.settings?.dependsOnEnvVars);
    const phaseFiles: Set<string> = new Set(collator.settings?.dependsOnAdditionalFiles);
    if (phaseEnvVars.has(GENERATION_VARIABLE)) {
      fail(collator, `${GENERATION_VARIABLE} is derived; do not list it in dependsOnEnvVars.`);
    }
    for (const shard of shards) {
      // Rush queries local inputs by associatedPhase.name, NOT by the shard's operationName.
      for (const name of shard.settings?.dependsOnEnvVars ?? []) {
        if (!phaseEnvVars.has(name)) {
          fail(shard, `Declare dependsOnEnvVars "${name}" on the original phase, not only on :shard.`);
        }
      }
      for (const pattern of shard.settings?.dependsOnAdditionalFiles ?? []) {
        if (!phaseFiles.has(pattern)) {
          fail(
            shard,
            `Declare dependsOnAdditionalFiles "${pattern}" on the original phase, not only on :shard.`
          );
        }
      }
    }
    groups.push({ preShard, shards, collator });
  }
  return groups;
}

export class HeftShardIdentityPlugin implements IRushPlugin {
  public readonly pluginName: string = PLUGIN_NAME;
  readonly #phaseNames: ReadonlySet<string>;

  public constructor(options: IHeftShardIdentityPluginOptions) {
    if (!options?.phaseNames?.length) {
      throw new Error(`${PLUGIN_NAME}: phaseNames must explicitly select the managed sharded phases.`);
    }
    this.#phaseNames = new Set(options.phaseNames);
  }

  public apply(session: RushSession): void {
    const hostVersion: string = Rush.version;
    if (
      typeof hostVersion !== 'string' ||
      valid(hostVersion) === null ||
      !eq(hostVersion, SUPPORTED_RUSH_VERSION)
    ) {
      throw new Error(
        `${PLUGIN_NAME}: Unsupported Rush host version "${hostVersion}"; required version: ` +
          `${SUPPORTED_RUSH_VERSION}. Install the plugin version that exactly matches the repository's ` +
          'Rush version.'
      );
    }
    session.hooks.runAnyPhasedCommand.tap(PLUGIN_NAME, (command) => {
      if (!command.hooks.onGraphCreatedAsync) {
        throw new Error(
          `${PLUGIN_NAME} requires the operation graph APIs from Rush ${SUPPORTED_RUSH_VERSION}.`
        );
      }
      command.hooks.onGraphCreatedAsync.tap(
        { name: PLUGIN_NAME, stage: Number.MAX_SAFE_INTEGER },
        (graph, context) => this.#configureGraph(graph, context)
      );
    });
  }

  #configureGraph(graph: IOperationGraph, context: IOperationGraphContext): void {
    const groups: IShardGroup[] = findGroups(graph.operations, this.#phaseNames);
    if (groups.length === 0) {
      return;
    }
    for (const { preShard, shards, collator } of groups) {
      // Rush 5.179 checks the original phase's disableBuildCacheForOperation for every sibling.
      // Use the public runner capability instead: preserve shard archive caching, but the current
      // collator must validate restored manifests and publish its own current verdict.
      collator.runner!.cacheable = false;
      const preShardRunner: IOperationRunner = preShard.runner!;
      const getOriginalConfigHash: () => string = preShardRunner.getConfigHash.bind(preShardRunner);
      // Rush hashes records before configureIteration. Read live runner configurations here
      // so later graph hooks and watch changes invalidate every sibling, without reading
      // execution records or recursively calling the decorated pre-shard callback.
      preShardRunner.getConfigHash = () =>
        hash([
          IDENTITY_VERSION,
          collator.associatedProject.packageName,
          collator.associatedPhase.name,
          process.version,
          process.platform,
          process.arch,
          getOriginalConfigHash(),
          collator.runner!.getConfigHash(),
          shards.map((shard) => shard.runner!.getConfigHash()).sort()
        ]);
      for (const shard of shards) {
        // Heft/Jest diagnostic text (and Jest's empty-partition notice) may use stderr even
        // when the committed result is complete. Only managed shards defer this verdict.
        shard.runner!.warningsAreAllowed = true;
      }
    }

    graph.hooks.configureIteration.tap({ name: PLUGIN_NAME, stage: Number.MAX_SAFE_INTEGER }, (records) => {
      for (const { preShard, shards, collator } of groups) {
        const groupRecords: IConfigurableOperation[] = [];
        for (const operation of [preShard, collator, ...shards]) {
          const record: IConfigurableOperation | undefined = records.get(operation);
          if (!record) {
            fail(operation, 'Missing current managed execution record.');
          }
          groupRecords.push(record);
        }
        // The collator is the original selected phase. Synthetic nodes must not override
        // its native decision (notably --changed-projects-only), but an enabled collator
        // may legitimately reuse unchanged shards without executing them again.
        const collatorEnabled: boolean = groupRecords[1].enabled;
        const { dependencies, local, config } = groupRecords[0].getStateHashComponents();
        const generation: string = hash([
          IDENTITY_VERSION,
          collator.associatedProject.packageName,
          collator.associatedPhase.name,
          [...dependencies].sort(),
          local,
          config
        ]);
        for (const record of groupRecords) {
          if (!collatorEnabled) {
            record.enabled = false;
          }
          if (record.operation !== preShard) {
            record.environmentOverrides = {
              ...record.environmentOverrides,
              [GENERATION_VARIABLE]: generation
            };
          }
        }
      }
    });

    graph.hooks.beforeExecuteIterationAsync.tap(
      { name: PLUGIN_NAME, stage: Number.MAX_SAFE_INTEGER },
      (records) => {
        for (const { shards, collator } of groups) {
          if (!context.buildCacheConfiguration?.buildCacheEnabled) {
            // Disable legacy local skipping, not an external executor's archive cache.
            // LegacySkipPlugin does not compare the shared managed identity.
            for (const shard of shards) {
              shard.runner!.cacheable = false;
            }
          }
          if (!records.get(collator)!.enabled) {
            for (const shard of shards) {
              if (records.get(shard)!.enabled) {
                fail(shard, 'Cannot execute a managed shard without its current collator.');
              }
            }
          }
        }
      }
    );
  }
}
