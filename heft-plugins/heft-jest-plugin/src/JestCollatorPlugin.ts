// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';

import type { HeftConfiguration, IHeftTaskPlugin, IHeftTaskSession } from '@rushstack/heft';

import { JestCollationAdapter, type IJestCollatorOptions } from './JestCollation';

export default class JestCollatorPlugin implements IHeftTaskPlugin<IJestCollatorOptions> {
  public apply(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    options?: IJestCollatorOptions
  ): void {
    const adapter: JestCollationAdapter = new JestCollationAdapter(
      heftConfiguration.buildFolderPath,
      taskSession.logger.terminal,
      options,
      {
        project: heftConfiguration.projectPackageJson.name,
        phase: path.relative(heftConfiguration.tempFolderPath, taskSession.tempFolderPath).split(path.sep)[0],
        task: taskSession.taskName
      }
    );
    taskSession.registerShardCollator(adapter);
  }
}
