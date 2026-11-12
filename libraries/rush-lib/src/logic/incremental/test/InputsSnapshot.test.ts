// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'node:path';

import { LookupByPath } from '@rushstack/lookup-by-path';

import type { RushProjectConfiguration } from '../../../api/RushProjectConfiguration';
import { RushConstants } from '../../RushConstants';
import {
  InputsSnapshot,
  type IInputsSnapshotParameters,
  type IRushConfigurationProjectForSnapshot
} from '../InputsSnapshot';

describe(InputsSnapshot.name, () => {
  function getTestConfig(): {
    project: IRushConfigurationProjectForSnapshot;
    options: IInputsSnapshotParameters;
  } {
    const project: IRushConfigurationProjectForSnapshot = {
      projectFolder: '/root/a',
      projectRelativeFolder: 'a'
    };

    return {
      project,
      options: {
        rootDir: '/root',
        additionalHashes: new Map([['/ext/config.json', 'hash4']]),
        hashes: new Map([
          ['a/file1.js', 'hash1'],
          ['a/file2.js', 'hash2'],
          ['a/lib/file3.js', 'hash3'],
          ['common/config/some-config.json', 'hash5']
        ]),
        hasUncommittedChanges: false,
        lookupByPath: new LookupByPath([[project.projectRelativeFolder, project]]),
        projectMap: new Map()
      }
    };
  }

  function getTrivialSnapshot(): {
    project: IRushConfigurationProjectForSnapshot;
    input: InputsSnapshot;
  } {
    const { project, options } = getTestConfig();

    const input: InputsSnapshot = new InputsSnapshot(options);

    return { project, input };
  }

  describe(InputsSnapshot.prototype.getTrackedFileHashesForOperation.name, () => {
    it('Handles trivial input', () => {
      const { project, input } = getTrivialSnapshot();

      const result: ReadonlyMap<string, string> = input.getTrackedFileHashesForOperation(project);

      expect(result).toMatchSnapshot();
      expect(result.size).toEqual(3);
      expect(result.get('a/file1.js')).toEqual('hash1');
      expect(result.get('a/file2.js')).toEqual('hash2');
      expect(result.get('a/lib/file3.js')).toEqual('hash3');
    });

    it('Detects outputFileNames collisions', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              outputFolderNames: ['lib']
            }
          ]
        ])
      };

      options.projectMap = new Map([
        [
          project,
          {
            projectConfig: projectConfig as RushProjectConfiguration
          }
        ]
      ]);

      const input: InputsSnapshot = new InputsSnapshot(options);

      expect(() =>
        input.getTrackedFileHashesForOperation(project, '_phase:build')
      ).toThrowErrorMatchingSnapshot();
    });

    it('Respects additionalFilesByOperationName', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build'
            }
          ]
        ])
      };

      const input: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig as RushProjectConfiguration,
              additionalFilesByOperationName: new Map([['_phase:build', new Set(['/ext/config.json'])]])
            }
          ]
        ])
      });

      const result: ReadonlyMap<string, string> = input.getTrackedFileHashesForOperation(
        project,
        '_phase:build'
      );

      expect(result).toMatchSnapshot();
      expect(result.size).toEqual(4);
      expect(result.get('a/file1.js')).toEqual('hash1');
      expect(result.get('a/file2.js')).toEqual('hash2');
      expect(result.get('a/lib/file3.js')).toEqual('hash3');
      expect(result.get('/ext/config.json')).toEqual('hash4');
    });

    function getOutputSnapshot(
      inputKind: 'tracked' | 'additional',
      filePath: string
    ): { project: IRushConfigurationProjectForSnapshot; input: InputsSnapshot } {
      const { project, options } = getTestConfig();
      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          ['_phase:build', { operationName: '_phase:build', outputFolderNames: ['lib'] }]
        ])
      };
      const input: InputsSnapshot = new InputsSnapshot({
        ...options,
        hashes: new Map([
          ['a/source.js', 'source-hash'],
          ...(inputKind === 'tracked' ? [[filePath, 'uncovered-hash'] as const] : [])
        ]),
        additionalHashes: new Map([[filePath, 'uncovered-hash']]),
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig as RushProjectConfiguration,
              additionalFilesByOperationName:
                inputKind === 'additional' ? new Map([['_phase:build', new Set([filePath])]]) : undefined
            }
          ]
        ])
      });
      return { project, input };
    }

    it.each([
      ['tracked', 'a/lib/uncovered.js'],
      ['additional', 'a/lib/uncovered.js'],
      ['additional', 'a/lib/../lib/uncovered.js'],
      ['additional', path.resolve('/root/a/lib/uncovered.js')]
    ] as const)('Rejects %s uncovered output inputs: %s', (inputKind, filePath) => {
      const { project, input } = getOutputSnapshot(inputKind, filePath);
      // A rejected snapshot must not cache a partially validated map for a later query.
      for (let attempt: number = 0; attempt < 2; attempt++) {
        expect(() => input.getTrackedFileHashesForOperation(project, '_phase:build')).toThrow(
          `contains ${inputKind} input file "${filePath}"`
        );
        expect(() => input.getOperationOwnStateHash(project, '_phase:build')).toThrow(
          'output to a disjoint folder'
        );
      }
    });

    (process.platform === 'win32' ? it.each : it.skip.each)([
      ['tracked', 'a/LIB/UNCOVERED.js'],
      ['additional', 'A/LIB/UNCOVERED.js'],
      ['additional', path.resolve('/root/a/lib/uncovered.js').toUpperCase()]
    ] as const)('Rejects differently cased Windows %s output inputs: %s', (inputKind, filePath) => {
      const { project, input } = getOutputSnapshot(inputKind, filePath);
      expect(() => input.getTrackedFileHashesForOperation(project, '_phase:build')).toThrow(
        `contains ${inputKind} input file "${filePath}"`
      );
    });

    it.each(['a/lib-sources/uncovered.js', path.resolve('/root/a/lib-sources/uncovered.js')])(
      'Preserves additional input keys and hashes beside an output folder: %s',
      (filePath) => {
        const { project, input } = getOutputSnapshot('additional', filePath);
        const hashes: ReadonlyMap<string, string> = input.getTrackedFileHashesForOperation(
          project,
          '_phase:build'
        );
        expect([...hashes]).toEqual([[filePath, 'uncovered-hash'], ['a/source.js', 'source-hash']]);
        expect(input.getTrackedFileHashesForOperation(project, '_phase:build')).toBe(hashes);
      }
    );

    it('Respects globalAdditionalFiles', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build'
            }
          ]
        ])
      };

      const input: InputsSnapshot = new InputsSnapshot({
        ...options,
        globalAdditionalFiles: new Set(['common/config/some-config.json']),
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig as RushProjectConfiguration
            }
          ]
        ])
      });

      const result: ReadonlyMap<string, string> = input.getTrackedFileHashesForOperation(
        project,
        '_phase:build'
      );

      expect(result).toMatchSnapshot();
      expect(result.size).toEqual(4);
      expect(result.get('a/file1.js')).toEqual('hash1');
      expect(result.get('a/file2.js')).toEqual('hash2');
      expect(result.get('a/lib/file3.js')).toEqual('hash3');
      expect(result.get('common/config/some-config.json')).toEqual('hash5');
    });

    it('Respects incrementalBuildIgnoredGlobs', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'incrementalBuildIgnoredGlobs'> = {
        incrementalBuildIgnoredGlobs: ['*2.js']
      };

      const input: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig as RushProjectConfiguration
            }
          ]
        ])
      });

      const result: ReadonlyMap<string, string> = input.getTrackedFileHashesForOperation(project);

      expect(result).toMatchSnapshot();
      expect(result.size).toEqual(2);
      expect(result.get('a/file1.js')).toEqual('hash1');
      expect(result.get('a/lib/file3.js')).toEqual('hash3');
    });
  });

  describe(InputsSnapshot.prototype.getOperationOwnStateHash.name, () => {
    it('Handles trivial input', () => {
      const { project, input } = getTrivialSnapshot();

      const result: string = input.getOperationOwnStateHash(project);

      expect(result).toMatchSnapshot();
    });

    it('Is invariant to input hash order', () => {
      const { project, options } = getTestConfig();

      const baseline: string = new InputsSnapshot(options).getOperationOwnStateHash(project);

      const input: InputsSnapshot = new InputsSnapshot({
        ...options,
        hashes: new Map(Array.from(options.hashes).reverse())
      });

      const result: string = input.getOperationOwnStateHash(project);

      expect(result).toEqual(baseline);
    });

    it('Detects outputFileNames collisions', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              outputFolderNames: ['lib']
            }
          ]
        ])
      };

      options.projectMap = new Map([
        [
          project,
          {
            projectConfig: projectConfig as RushProjectConfiguration
          }
        ]
      ]);

      const input: InputsSnapshot = new InputsSnapshot(options);

      expect(() => input.getOperationOwnStateHash(project, '_phase:build')).toThrowErrorMatchingSnapshot();
    });

    it('Changes if outputFileNames changes', () => {
      const { project, options } = getTestConfig();
      const baseline: string = new InputsSnapshot(options).getOperationOwnStateHash(project, '_phase:build');

      const projectConfig1: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              outputFolderNames: ['lib-commonjs']
            }
          ]
        ])
      };

      const projectConfig2: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              outputFolderNames: ['lib-esm']
            }
          ]
        ])
      };

      const input1: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig1 as RushProjectConfiguration
            }
          ]
        ])
      });

      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig2 as RushProjectConfiguration
            }
          ]
        ])
      });

      const result1: string = input1.getOperationOwnStateHash(project, '_phase:build');

      const result2: string = input2.getOperationOwnStateHash(project, '_phase:build');

      expect(result1).not.toEqual(baseline);
      expect(result2).not.toEqual(baseline);
      expect(result1).not.toEqual(result2);
    });

    it('Respects additionalOutputFilesByOperationName', () => {
      const { project, options } = getTestConfig();
      const baseline: string = new InputsSnapshot(options).getOperationOwnStateHash(project, '_phase:build');

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build'
            }
          ]
        ])
      };

      const input: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig as RushProjectConfiguration,
              additionalFilesByOperationName: new Map([['_phase:build', new Set(['/ext/config.json'])]])
            }
          ]
        ])
      });

      const result: string = input.getOperationOwnStateHash(project, '_phase:build');

      expect(result).toMatchSnapshot();
      expect(result).not.toEqual(baseline);
    });

    it('Respects globalAdditionalFiles', () => {
      const { project, options } = getTestConfig();
      const baseline: string = new InputsSnapshot(options).getOperationOwnStateHash(project, '_phase:build');

      const input: InputsSnapshot = new InputsSnapshot({
        ...options,
        globalAdditionalFiles: new Set(['common/config/some-config.json'])
      });

      const result: string = input.getOperationOwnStateHash(project);

      expect(result).toMatchSnapshot();
      expect(result).not.toEqual(baseline);
    });

    it('Respects incrementalBuildIgnoredGlobs', () => {
      const { project, options } = getTestConfig();
      const baseline: string = new InputsSnapshot(options).getOperationOwnStateHash(project, '_phase:build');

      const projectConfig1: Pick<RushProjectConfiguration, 'incrementalBuildIgnoredGlobs'> = {
        incrementalBuildIgnoredGlobs: ['*2.js']
      };

      const input1: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig1 as RushProjectConfiguration
            }
          ]
        ])
      });

      const result1: string = input1.getOperationOwnStateHash(project);

      expect(result1).toMatchSnapshot();
      expect(result1).not.toEqual(baseline);

      const projectConfig2: Pick<RushProjectConfiguration, 'incrementalBuildIgnoredGlobs'> = {
        incrementalBuildIgnoredGlobs: ['*1.js']
      };

      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig2 as RushProjectConfiguration
            }
          ]
        ])
      });

      const result2: string = input2.getOperationOwnStateHash(project);

      expect(result2).toMatchSnapshot();
      expect(result2).not.toEqual(baseline);

      expect(result2).not.toEqual(result1);
    });

    it('Respects dependsOnNodeVersion', () => {
      const { project, options } = getTestConfig();
      const baseline: string = new InputsSnapshot(options).getOperationOwnStateHash(project, '_phase:build');

      const projectConfig1: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              dependsOnNodeVersion: true
            }
          ]
        ])
      };

      const input1: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig1 as RushProjectConfiguration
            }
          ]
        ]),
        nodeVersion: 'v20.10.0'
      });

      const result1: string = input1.getOperationOwnStateHash(project, '_phase:build');

      expect(result1).toMatchSnapshot();
      expect(result1).not.toEqual(baseline);

      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig1 as RushProjectConfiguration
            }
          ]
        ]),
        nodeVersion: 'v22.12.0'
      });

      const result2: string = input2.getOperationOwnStateHash(project, '_phase:build');

      expect(result2).toMatchSnapshot();
      expect(result2).not.toEqual(baseline);
      expect(result2).not.toEqual(result1);
    });

    it('Respects dependsOnNodeVersion with major granularity', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              dependsOnNodeVersion: 'major'
            }
          ]
        ])
      };

      // Same major, different minor - should produce the same hash
      const input1: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v20.10.0'
      });

      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v20.18.3'
      });

      const result1: string = input1.getOperationOwnStateHash(project, '_phase:build');
      const result2: string = input2.getOperationOwnStateHash(project, '_phase:build');

      expect(result1).toEqual(result2);

      // Different major - should produce a different hash
      const input3: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v22.12.0'
      });

      const result3: string = input3.getOperationOwnStateHash(project, '_phase:build');

      expect(result3).not.toEqual(result1);
    });

    it('Respects dependsOnNodeVersion with minor granularity', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              dependsOnNodeVersion: 'minor'
            }
          ]
        ])
      };

      // Same major.minor, different patch - should produce the same hash
      const input1: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v20.10.0'
      });

      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v20.10.5'
      });

      const result1: string = input1.getOperationOwnStateHash(project, '_phase:build');
      const result2: string = input2.getOperationOwnStateHash(project, '_phase:build');

      expect(result1).toEqual(result2);

      // Different minor - should produce a different hash
      const input3: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v20.18.0'
      });

      const result3: string = input3.getOperationOwnStateHash(project, '_phase:build');

      expect(result3).not.toEqual(result1);
    });

    it('Respects dependsOnNodeVersion with patch granularity', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              dependsOnNodeVersion: 'patch'
            }
          ]
        ])
      };

      // true and 'patch' should produce identical hashes
      const projectConfigTrue: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              dependsOnNodeVersion: true
            }
          ]
        ])
      };

      const inputPatch: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v18.17.1'
      });

      const inputTrue: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfigTrue as RushProjectConfiguration }]]),
        nodeVersion: 'v18.17.1'
      });

      const resultPatch: string = inputPatch.getOperationOwnStateHash(project, '_phase:build');
      const resultTrue: string = inputTrue.getOperationOwnStateHash(project, '_phase:build');

      expect(resultPatch).toEqual(resultTrue);

      // Different patch - should produce a different hash
      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]]),
        nodeVersion: 'v18.17.2'
      });

      const result2: string = input2.getOperationOwnStateHash(project, '_phase:build');

      expect(result2).not.toEqual(resultPatch);
    });

    it('Does not include node version when dependsOnNodeVersion is not set', () => {
      const { project, options } = getTestConfig();

      const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build'
            }
          ]
        ])
      };

      const input1: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig as RushProjectConfiguration
            }
          ]
        ]),
        nodeVersion: 'v20.10.0'
      });

      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig as RushProjectConfiguration
            }
          ]
        ]),
        nodeVersion: 'v22.12.0'
      });

      const result1: string = input1.getOperationOwnStateHash(project, '_phase:build');
      const result2: string = input2.getOperationOwnStateHash(project, '_phase:build');

      expect(result1).toEqual(result2);
    });

    it('Respects dependsOnEnvVars', () => {
      const { project, options } = getTestConfig();
      const baseline: string = new InputsSnapshot(options).getOperationOwnStateHash(project, '_phase:build');

      const projectConfig1: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
        operationSettingsByOperationName: new Map([
          [
            '_phase:build',
            {
              operationName: '_phase:build',
              dependsOnEnvVars: ['ENV_VAR']
            }
          ]
        ])
      };

      const input1: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig1 as RushProjectConfiguration
            }
          ]
        ]),
        environment: {}
      });

      const result1: string = input1.getOperationOwnStateHash(project, '_phase:build');

      expect(result1).toMatchSnapshot();
      expect(result1).not.toEqual(baseline);

      const input2: InputsSnapshot = new InputsSnapshot({
        ...options,
        projectMap: new Map([
          [
            project,
            {
              projectConfig: projectConfig1 as RushProjectConfiguration
            }
          ]
        ]),
        environment: { ENV_VAR: 'some_value' }
      });

      const result2: string = input2.getOperationOwnStateHash(project, '_phase:build');

      expect(result2).toMatchSnapshot();
      expect(result2).not.toEqual(baseline);
      expect(result2).not.toEqual(result1);
    });

    describe('environment identity', () => {
      function createSnapshot(
        environment: Record<string, string | undefined>,
        names: string[] = ['ENV_VAR']
      ): ReturnType<typeof getTrivialSnapshot> {
        const { project, options } = getTestConfig();
        const projectConfig: Pick<RushProjectConfiguration, 'operationSettingsByOperationName'> = {
          operationSettingsByOperationName: new Map([
            ['_phase:build', { operationName: '_phase:build', dependsOnEnvVars: names }]
          ])
        };
        return {
          project,
          input: new InputsSnapshot({
            ...options,
            environment,
            projectMap: new Map([[project, { projectConfig: projectConfig as RushProjectConfiguration }]])
          })
        };
      }

      function getHash(environment: Record<string, string | undefined>, names?: string[]): string {
        const { project, input } = createSnapshot(environment, names);
        return input.getOperationOwnStateHash(project, '_phase:build');
      }

      it('distinguishes absence, empty values and literal sentinel strings', () => {
        const values: Array<string | undefined> = [undefined, '', 'undefined', 'null', 'value'];
        expect(new Set(values.map((value) => getHash({ ENV_VAR: value }))).size).toBe(values.length);
        expect(getHash({})).toBe(getHash({ ENV_VAR: undefined }));
      });

      it('uses platform environment-name semantics', () => {
        const upper: string = getHash({ ENV_VAR: 'first' });
        const lower: string = getHash({ env_var: 'first' });
        const changed: string = getHash({ env_var: 'second' });
        if (process.platform === 'win32') {
          expect(lower).toBe(upper);
          expect(changed).not.toBe(lower);
        } else {
          expect(lower).toBe(getHash({}));
          expect(changed).toBe(lower);
          expect(lower).not.toBe(upper);
        }
      });

      it('captures supplied values before the first hash query', () => {
        const environment: Record<string, string | undefined> = { ENV_VAR: 'captured' };
        const { project, input } = createSnapshot(environment);
        environment.ENV_VAR = 'changed';
        expect(input.getOperationOwnStateHash(project, '_phase:build')).toBe(getHash({ ENV_VAR: 'captured' }));
      });

      it('does not include undeclared environment inputs', () => {
        expect(getHash({ ENV_VAR: 'same', OTHER: 'first' })).toBe(
          getHash({ ENV_VAR: 'same', OTHER: 'second' })
        );
      });

      it('does not confuse embedded separators with another declared variable', () => {
        const delimiter: string = RushConstants.hashDelimiter;
        expect(getHash({ A: `a${delimiter}$B=b`, B: 'c' }, ['A', 'B'])).not.toBe(
          getHash({ A: 'a', B: `b${delimiter}$B=c` }, ['A', 'B'])
        );
      });
    });
  });
});
