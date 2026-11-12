// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '@jest/types';
import type { IJestCollatorOptions } from '../JestCollation';

export interface ICliResult {
  code: ChildProcess['exitCode'];
  output: string;
}

const PACKAGE_FOLDER: string = path.resolve(__dirname, '..', '..');
// Low-level plugin regressions use workspace Heft. The dependency-ordered Rush shell/cache
// acceptance suite lives separately in build-tests/heft-sharding-test.
const HEFT_START: string = path.resolve(
  PACKAGE_FOLDER,
  '..',
  '..',
  'apps',
  'heft',
  'lib-commonjs',
  'start.js'
);

export async function runHeftCommandAsync(
  folder: string,
  args: string[],
  generation?: string
): Promise<ICliResult> {
  return await runNodeAsync(folder, [HEFT_START, ...args], generation);
}

export async function runJestTaskHookInChildAsync(
  folder: string,
  taskName: string,
  abortMicrotasks: number = 0
): Promise<ICliResult> {
  return await runNodeAsync(
    folder,
    [path.join(__dirname, 'JestShardTaskHookRunner.js'), taskName, String(abortMicrotasks)],
    'generation-1'
  );
}

/** The bounded heap and termination target belong only to this disposable fixture subprocess. */
export async function runIsolatedJestFaultAsync(
  folder: string,
  nodeArgs: readonly string[] = [],
  abortOnFile: string = '',
  timeoutMs: number = 120000
): Promise<ICliResult> {
  return await runNodeAsync(
    folder,
    [
      '--max-old-space-size=96',
      ...nodeArgs,
      path.join(__dirname, 'JestShardTaskHookRunner.js'),
      'jest',
      '0',
      abortOnFile,
      'fault'
    ],
    'generation-1',
    true,
    timeoutMs
  );
}

async function runNodeAsync(
  folder: string,
  args: string[],
  generation: string | undefined,
  expectTermination: boolean = false,
  timeoutMs: number = 120000
): Promise<ICliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: folder,
      env: {
        ...process.env,
        JEST_WORKER_ID: undefined,
        RUSH_SHARD_GENERATION: generation,
        FORCE_COLOR: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Shared Windows hosts can take tens of seconds just to start the nested CLI.
      timeout: timeoutMs
    });
    let output: string = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (!expectTermination && (signal || code === null)) {
        reject(new Error(`Heft terminated (${signal}):\n${output}`));
      } else {
        resolve({ code, output });
      }
    });
  });
}

export async function runHeftAsync(
  folder: string,
  args: string[],
  generation: string | undefined = 'generation-1'
): Promise<ICliResult> {
  return await runHeftCommandAsync(
    folder,
    ['run', '--only', 'test', '--', '--max-workers=1', ...args],
    generation
  );
}

export async function writeConfigAsync(folder: string, overrides: Config.InitialOptions = {}): Promise<void> {
  await fs.writeFile(
    path.join(folder, 'config', 'jest.config.json'),
    JSON.stringify({
      testEnvironment: require.resolve('jest-environment-node'),
      testMatch: ['<rootDir>/*.test.js'],
      transform: {},
      ...overrides
    })
  );
}

export async function createFixtureAsync(): Promise<string> {
  const folder: string = await fs.mkdtemp(
    path.join(PACKAGE_FOLDER, 'lib-commonjs', 'test', 'jest-shard-fixture-')
  );
  await fs.mkdir(path.join(folder, 'node_modules', '@rushstack'), { recursive: true });
  await fs.symlink(
    PACKAGE_FOLDER,
    path.join(folder, 'node_modules', '@rushstack', 'heft-jest-plugin'),
    'junction'
  );
  await fs.symlink(
    path.dirname(require.resolve('@rushstack/heft/package.json')),
    path.join(folder, 'node_modules', '@rushstack', 'heft'),
    'junction'
  );
  await fs.mkdir(path.join(folder, 'config'));
  await fs.writeFile(
    path.join(folder, 'package.json'),
    JSON.stringify({ name: 'jest-shard-fixture', version: '1.0.0' })
  );
  await fs.writeFile(
    path.join(folder, 'config', 'heft.json'),
    JSON.stringify({
      phasesByName: {
        // Intentionally omit pluginName: adding the collator must not break existing consumers.
        test: { tasksByName: { jest: { taskPlugin: { pluginPackage: '@rushstack/heft-jest-plugin' } } } }
      }
    })
  );
  await writeConfigAsync(folder);
  return folder;
}

export async function configureCoverageCollatorAsync(
  folder: string,
  options?: IJestCollatorOptions
): Promise<void> {
  await fs.writeFile(
    path.join(folder, 'config', 'heft.json'),
    JSON.stringify({
      phasesByName: {
        test: { tasksByName: { jest: { taskPlugin: { pluginPackage: '@rushstack/heft-jest-plugin' } } } },
        collate: {
          tasksByName: {
            collate: {
              taskPlugin: {
                pluginPackage: '@rushstack/heft-jest-plugin',
                pluginName: 'jest-collator-plugin',
                options
              }
            },
            downstream: {
              taskDependencies: ['collate'],
              taskPlugin: {
                pluginPackage: '@rushstack/heft',
                pluginName: 'copy-files-plugin',
                options: {
                  copyOperations: [
                    {
                      sourcePath: 'temp',
                      destinationFolders: ['downstream'],
                      includeGlobs: ['jest-collated.json']
                    }
                  ]
                }
              }
            }
          }
        }
      }
    })
  );
}
