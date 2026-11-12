// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { Config } from '@jest/types';

import { validateShardPathAsync } from '@rushstack/heft/lib/sharding/ShardFileSystem';

export interface IJestCoverageExecutionInput {
  filename: string;
  source: string;
  /** Present only after the canonical transform has returned successfully. */
  code?: string;
  instrument: boolean;
}

interface IExecutionInputEnvelope {
  version: 1;
  attempt: string;
  payload: string;
  sha256: string;
}

export function getExecutionInputsPath(config: Config.ProjectConfig, attempt: string): string {
  if (!/^[a-f0-9-]{36}$/.test(attempt)) throw new Error('Invalid managed Jest coverage attempt.');
  return path.join(config.cacheDirectory, 'execution-inputs', `${attempt}.jsonl`);
}

function encode(attempt: string, input: IJestCoverageExecutionInput | undefined): string {
  const payload: string = JSON.stringify(input ?? null);
  const envelope: IExecutionInputEnvelope = {
    version: 1,
    attempt,
    payload,
    sha256: createHash('sha256').update(payload).digest('hex')
  };
  return `${JSON.stringify(envelope)}\n`;
}

export async function initializeExecutionInputsAsync(
  config: Config.ProjectConfig,
  attempt: string
): Promise<void> {
  const filename: string = getExecutionInputsPath(config, attempt);
  await validateShardPathAsync(config.rootDir, filename);
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  await validateShardPathAsync(config.rootDir, filename);
  await fs.promises.writeFile(filename, encode(attempt, undefined), { flag: 'wx' });
}

/**
 * Managed shards use one Jest worker. Synchronous append preserves every observation, including
 * earlier different text and transforms whose code is served from the canonical disk cache.
 */
export function recordExecutionInput(
  config: Config.ProjectConfig,
  attempt: string,
  input: IJestCoverageExecutionInput
): void {
  const filename: string = getExecutionInputsPath(config, attempt);
  let current: string = config.rootDir;
  const relative: string = path.relative(current, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Execution-input evidence must be below the build folder.');
  }
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat: fs.Stats = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (current === filename && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error('Invalid Jest execution-input evidence path.');
    }
  }
  fs.appendFileSync(filename, encode(attempt, input));
}

export async function readExecutionInputsAsync(
  config: Config.ProjectConfig,
  attempt: string
): Promise<IJestCoverageExecutionInput[]> {
  const filename: string = getExecutionInputsPath(config, attempt);
  await validateShardPathAsync(config.rootDir, filename);
  const stat: fs.Stats = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid Jest execution-input evidence file.');
  const text: string = await fs.promises.readFile(filename, 'utf8');
  const inputs: IJestCoverageExecutionInput[] = [];
  let offset: number = 0;
  while (offset < text.length) {
    const end: number = text.indexOf('\n', offset);
    if (end < 0) throw new Error('Incomplete Jest execution-input evidence.');
    const envelope: IExecutionInputEnvelope = JSON.parse(text.slice(offset, end));
    if (
      envelope.version !== 1 ||
      envelope.attempt !== attempt ||
      typeof envelope.payload !== 'string' ||
      envelope.sha256 !== createHash('sha256').update(envelope.payload).digest('hex')
    ) {
      throw new Error('Corrupt Jest execution-input evidence.');
    }
    const input: IJestCoverageExecutionInput | null = JSON.parse(envelope.payload);
    if (offset === 0) {
      if (input !== null) throw new Error('Missing Jest execution-input evidence header.');
    } else {
      if (
        !input ||
        typeof input.filename !== 'string' ||
        typeof input.source !== 'string' ||
        typeof input.instrument !== 'boolean' ||
        (input.code !== undefined && typeof input.code !== 'string')
      ) {
        throw new Error('Invalid Jest execution-input observation.');
      }
      inputs.push(input);
    }
    offset = end + 1;
  }
  if (!offset) throw new Error('Missing Jest execution-input evidence header.');
  return inputs;
}

export async function removeExecutionInputsAsync(
  config: Config.ProjectConfig,
  attempt: string
): Promise<void> {
  const filename: string = getExecutionInputsPath(config, attempt);
  await validateShardPathAsync(config.rootDir, filename);
  await fs.promises.unlink(filename);
}
