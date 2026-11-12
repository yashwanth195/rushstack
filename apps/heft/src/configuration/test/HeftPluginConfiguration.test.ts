// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import { HeftPluginConfiguration, type IHeftPluginConfigurationJson } from '../HeftPluginConfiguration';

describe('explicit default plugin selection', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(__dirname, 'plugin-config-'));
  });
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  async function loadAsync(defaultPluginName?: string, count: number = 2): Promise<HeftPluginConfiguration> {
    const config: IHeftPluginConfigurationJson = {
      defaultPluginName,
      taskPlugins: [
        { pluginName: 'original', entryPoint: './original.js' },
        { pluginName: 'adapter', entryPoint: './adapter.js' }
      ].slice(0, count)
    };
    await fs.writeFile(path.join(folder, 'heft-plugin.json'), JSON.stringify(config));
    return await HeftPluginConfiguration.loadFromPackageAsync(folder, 'fixture');
  }

  it('preserves unnamed selection while allowing explicit adapter selection', async () => {
    const config = await loadAsync('original');
    expect(
      config.getPluginDefinitionBySpecifier({ pluginPackage: 'fixture', pluginPackageRoot: folder })
        .pluginName
    ).toBe('original');
    expect(
      config.getPluginDefinitionBySpecifier({
        pluginPackage: 'fixture',
        pluginPackageRoot: folder,
        pluginName: 'adapter'
      }).pluginName
    ).toBe('adapter');
  });

  it('does not make an ambiguous package silently choose its first plugin', async () => {
    const config = await loadAsync();
    expect(() =>
      config.getPluginDefinitionBySpecifier({ pluginPackage: 'fixture', pluginPackageRoot: folder })
    ).toThrow(/multiple plugins/);
  });

  it('preserves existing single-plugin selection', async () => {
    const config = await loadAsync(undefined, 1);
    expect(
      config.getPluginDefinitionBySpecifier({ pluginPackage: 'fixture', pluginPackageRoot: folder })
        .pluginName
    ).toBe('original');
  });

  it('rejects an unknown default even for explicitly named consumers', async () => {
    await expect(loadAsync('missing')).rejects.toThrow(/Unknown defaultPluginName/);
  });
});
