// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { AsyncParallelHook, AsyncSeriesWaterfallHook } from 'tapable';
import { DynamicCommandLineParser } from '@rushstack/ts-command-line';
import { StringBufferTerminalProvider, Terminal } from '@rushstack/terminal';

import { ShardCollationTask } from '../ShardCollationTask';
import type { IShardCollationAdapter } from '../IShardCollationAdapter';

function createSession(mode?: 'clean' | 'watch'): Parameters<ShardCollationTask['register']>[0] {
  const parser: DynamicCommandLineParser = new DynamicCommandLineParser({
    toolFilename: 'test',
    toolDescription: 'Sharding runtime test'
  });
  parser.defineStringParameter({
    parameterLongName: '--shard-parent-folder',
    argumentName: 'PATH',
    description: 'Shard parent folder'
  });
  parser.defineIntegerParameter({
    parameterLongName: '--shard-count',
    argumentName: 'COUNT',
    description: 'Shard count'
  });
  return {
    hooks: {
      run: new AsyncParallelHook(['options']),
      runIncremental: new AsyncParallelHook(['options']),
      registerFileOperations: new AsyncSeriesWaterfallHook(['operations'])
    },
    parameters: {
      watch: mode === 'watch',
      clean: mode === 'clean',
      debug: false,
      verbose: false,
      production: false,
      locales: [],
      getStringParameter: parser.getStringParameter.bind(parser),
      getIntegerParameter: parser.getIntegerParameter.bind(parser),
      getFlagParameter: parser.getFlagParameter.bind(parser),
      getStringListParameter: parser.getStringListParameter.bind(parser),
      getIntegerListParameter: parser.getIntegerListParameter.bind(parser),
      getChoiceParameter: parser.getChoiceParameter.bind(parser),
      getChoiceListParameter: parser.getChoiceListParameter.bind(parser)
    },
    logger: {
      loggerName: 'collate',
      terminal: new Terminal(new StringBufferTerminalProvider(false)),
      hasErrors: false,
      emitError: (error) => {
        throw error;
      },
      emitWarning: (error) => {
        throw error;
      },
      resetErrorsAndWarnings: () => {}
    }
  };
}

const adapter: IShardCollationAdapter = {
  acquireAsync: async () => {
    throw new Error('Registration must not acquire outputs.');
  }
};

describe('Heft core shard collation registration', () => {
  it('installs exactly one workload lifecycle on the registering task', () => {
    const session = createSession();
    const runtime = new ShardCollationTask();
    runtime.register(session, __dirname, adapter);
    expect(session.hooks.run.taps).toHaveLength(1);
    expect(() => runtime.register(session, __dirname, adapter)).toThrow(/exactly one.*multiple/);
    expect(session.hooks.run.taps).toHaveLength(1);
  });

  it.each(['clean', 'watch'] as const)('rejects %s mode before registering work', (mode) => {
    const session = createSession(mode);
    expect(() => new ShardCollationTask().register(session, __dirname, adapter)).toThrow(
      /does not support watch mode or --clean/
    );
    expect(session.hooks.run.taps).toHaveLength(0);
  });
});
