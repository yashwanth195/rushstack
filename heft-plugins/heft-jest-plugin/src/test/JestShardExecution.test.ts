// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AggregatedResult } from '@jest/reporters';
import { createCoverageMap } from 'istanbul-lib-coverage';

import {
  getShardManifestPath,
  readShardResultManifestAsync,
  tryReadShardResultManifestAsync
} from '@rushstack/heft/lib/sharding/ShardResultManifest';
import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';

import {
  completeJestShardExecutionAsync,
  prepareJestShardExecutionAsync,
  type IJestShardExecution
} from '../JestShardExecution';
import {
  createJestShardPayload,
  validateJestShardManifest,
  validateJestShardPayload,
  type IJestShardPayload
} from '../JestShardPayload';

import {
  configureCoverageCollatorAsync,
  createFixtureAsync,
  runHeftAsync,
  runHeftCommandAsync,
  runIsolatedJestFaultAsync,
  runJestTaskHookInChildAsync,
  writeConfigAsync,
  type ICliResult
} from './JestShardTestHelpers';
const MANAGED_ARGS: string[] = ['--shard=1/1', '--shard-output-directory=shards/1'];
interface IWorkerIdentity {
  pid: number;
  threadId: number;
  isMainThread: boolean;
}
const FAILURE_TESTS: string =
  "test('passes', () => expect(1).toBe(1));\n" +
  "test('assertion fails', () => expect(1).toBe(2));\n" +
  "test.skip('skipped', () => {});\n" +
  "test.todo('todo');\n" +
  "test('timeout', () => new Promise(() => {}), 20);\n" +
  "test('snapshot', () => expect('new snapshot').toMatchSnapshot());\n";

describe('managed Jest shard execution (workspace Heft CLI)', () => {
  let folder: string;
  let outputFolder: string;

  beforeEach(async () => {
    folder = await createFixtureAsync();
    outputFolder = path.join(folder, 'shards', '1');
  });
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('records assertions, timeouts, snapshots and suite-only failures without failing the managed operation', async () => {
    await fs.writeFile(path.join(folder, 'assertions.test.js'), FAILURE_TESTS);
    await fs.writeFile(path.join(folder, 'runtime.test.js'), "throw new Error('suite execution failed');");
    const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(result).toEqual({ code: 0, output: expect.stringContaining('verdict deferred to collator') });
    const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
    const payload: IJestShardPayload = validateJestShardManifest(manifest);
    expect(manifest.itemCount).toBe(4);
    expect(manifest.diagnosticCount).toBeGreaterThanOrEqual(4);
    expect(payload).toMatchObject({
      passed: 1,
      failed: 3,
      skipped: 1,
      todo: 1,
      failedSuites: 2,
      runtimeErrorSuites: 1,
      snapshotFailure: true,
      success: false
    });
    expect(payload.testFiles.find((file) => file.path === 'runtime.test.js')?.executionError).toContain(
      'suite execution failed'
    );
    const failures = payload.testFiles.find((file) => file.path === 'assertions.test.js')!.failures;
    expect(failures.map((failure) => failure.testName)).toEqual(['assertion fails', 'timeout', 'snapshot']);
    expect(failures[1].messages.join('\n')).toContain('Exceeded timeout');
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(await fs.readdir(folder)).not.toContain('__snapshots__');
  }, 60000);

  it.each([[], ['--shard=1/1']])(
    'keeps normal failure exits without managed output: %j',
    async (...args) => {
      await fs.writeFile(path.join(folder, 'failure.test.js'), "test('fails', () => expect(1).toBe(2));");
      const result: ICliResult = await runHeftAsync(folder, args, '');
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('1 Jest test failed');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    60000
  );

  it.each(['off', 'v8'] as const)(
    'preserves the native warm transform cache with coverage %s',
    async (provider) => {
      const source: string =
        provider === 'v8'
          ? 'module.exports = 1;\n//# sourceMappingURL=source.js.map\n'
          : 'module.exports = 1;\n';
      await fs.writeFile(path.join(folder, 'source.js'), source);
      if (provider === 'v8') {
        await fs.writeFile(path.join(folder, 'source.ts'), 'export default 1;\n');
        await fs.writeFile(
          path.join(folder, 'source.js.map'),
          JSON.stringify({
            version: 3,
            file: 'source.js',
            sources: ['source.ts'],
            sourcesContent: ['export default 1;\n'],
            names: [],
            mappings: 'AAAA'
          })
        );
      }
      await fs.writeFile(
        path.join(folder, 'cache.test.js'),
        "test('loads source', () => expect(require('./source')).toBe(1));"
      );
      await fs.writeFile(
        path.join(folder, 'transformer.js'),
        `module.exports = {
          process(code) {
            require('fs').appendFileSync(__dirname + '/process.log', 'process\\n');
            return { code };
          }
        };`
      );
      await writeConfigAsync(folder, {
        transform: { 'source\\.js$': '<rootDir>/transformer.js' },
        ...(provider === 'v8'
          ? { collectCoverage: true, coverageProvider: 'v8', collectCoverageFrom: ['source.js'] }
          : {})
      });
      const first: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      if (first.code !== 0) throw new Error(first.output);
      expect(await fs.readFile(path.join(folder, 'process.log'), 'utf8')).toBe('process\n');
      const second: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      if (second.code !== 0) throw new Error(second.output);
      expect(await fs.readFile(path.join(folder, 'process.log'), 'utf8')).toBe('process\n');
    },
    60000
  );

  it('rejects a warm V8 transform whose changed code has no verifiable source map', async () => {
    await fs.writeFile(path.join(folder, 'source.js'), 'module.exports = 1;\n');
    await fs.writeFile(
      path.join(folder, 'cache.test.js'),
      "test('loads source', () => expect(require('./source')).toBe(1));"
    );
    await fs.writeFile(
      path.join(folder, 'transformer.js'),
      `module.exports = {
        getCacheKey() { return 'stable'; },
        process() { return { code: 'module.exports = 1; // transformed' }; }
      };`
    );
    const transform = { 'source\\.js$': '<rootDir>/transformer.js' };
    await writeConfigAsync(folder, { transform });
    const warm: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    if (warm.code !== 0) throw new Error(warm.output);
    await writeConfigAsync(folder, {
      transform,
      collectCoverage: true,
      coverageProvider: 'v8',
      collectCoverageFrom: ['source.js']
    });
    const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Transformed V8 coverage requires a verifiable source map');
  }, 60000);

  it.each(['off', 'babel', 'v8'] as const)(
    'defers ordinary import messages and stack paths to the collator with coverage %s',
    async (provider) => {
      await configureCoverageCollatorAsync(folder);
      await fs.writeFile(path.join(folder, 'source.js'), 'module.exports = value => value ? 1 : 2;\n');
      const messages: string[] = [
        'application configuration missing',
        'child process configuration missing',
        'SIGTERM handler configuration missing',
        'worker exception configuration missing',
        'out of memory configuration missing',
        'call retries were exceeded configuration missing'
      ];
      for (const [index, message] of messages.entries()) {
        await fs.writeFile(
          path.join(folder, `import-${index}.test.js`),
          `require('./source')(true); throw new Error(${JSON.stringify(message)});`
        );
      }
      for (const segment of ['worker exception', 'child process', 'SIGTERM']) {
        await fs.mkdir(path.join(folder, segment));
        await fs.writeFile(
          path.join(folder, segment, 'import.js'),
          "throw new Error('application configuration missing');"
        );
        await fs.writeFile(
          path.join(folder, `${segment}.test.js`),
          `require('./source')(true); require('./${segment}/import');`
        );
      }
      await fs.writeFile(
        path.join(folder, 'assertion.test.js'),
        "test('child process SIGTERM worker assertion', () => expect(1).toBe(2));"
      );
      await writeConfigAsync(folder, {
        workerIdleMemoryLimit: '1KB',
        workerThreads: provider === 'v8',
        ...(provider === 'off'
          ? {}
          : {
              collectCoverage: true,
              coverageProvider: provider,
              collectCoverageFrom: ['source.js']
            })
      });
      const execution: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      expect(execution).toEqual({ code: 0, output: expect.stringContaining('verdict deferred') });
      const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
      const payload: IJestShardPayload = validateJestShardManifest(manifest);
      expect(manifest).toMatchObject({ itemCount: 1, diagnosticCount: 10 });
      expect(payload).toMatchObject({ success: false, failed: 1, runtimeErrorSuites: 9, failedSuites: 10 });
      const filesByPath = new Map(payload.testFiles.map((file) => [file.path, file]));
      for (const [index, message] of messages.entries()) {
        expect(filesByPath.get(`import-${index}.test.js`)?.executionError).toContain(message);
      }
      for (const segment of ['worker exception', 'child process', 'SIGTERM']) {
        expect(filesByPath.get(`${segment}.test.js`)?.executionError).toContain(segment);
      }
      const collated: ICliResult = await runHeftCommandAsync(
        folder,
        ['run', '--only', 'collate', '--', '--shard-parent-folder=shards', '--shard-count=1'],
        'generation-1'
      );
      expect(collated.code).not.toBe(0);
      const report = JSON.parse(await fs.readFile(path.join(folder, 'temp', 'jest-collated.json'), 'utf8'));
      expect(report).toMatchObject({ success: false });
      await expect(fs.stat(path.join(folder, 'downstream', 'jest-collated.json'))).rejects.toThrow(/ENOENT/);
    },
    120000
  );

  it.each(['off', 'babel', 'v8'] as const)(
    'preserves returned afterAll assertions, errors and coverage %s in serial and worker execution',
    async (provider) => {
      await configureCoverageCollatorAsync(folder);
      await fs.writeFile(path.join(folder, 'source.js'), 'module.exports = value => value ? 1 : 2;\n');
      await fs.writeFile(
        path.join(folder, 'after-all.test.js'),
        `
        const source = require('./source');
        test('completed assertion', () => expect(source(true)).toBe(1));
        afterAll(() => { throw new Error('ordinary afterAll configuration missing'); });
      `
      );
      for (const mode of ['serial', 'process', 'thread']) {
        await writeConfigAsync(folder, {
          workerIdleMemoryLimit: mode === 'serial' ? undefined : '1GB',
          workerThreads: mode === 'thread',
          ...(provider === 'off'
            ? {}
            : {
                collectCoverage: true,
                coverageProvider: provider,
                collectCoverageFrom: ['source.js']
              })
        });
        const execution: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
        expect(execution).toEqual({ code: 0, output: expect.stringContaining('verdict deferred') });
        const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
        expect(manifest).toMatchObject({ itemCount: 1, diagnosticCount: 1 });
        const payload: IJestShardPayload = validateJestShardManifest(manifest);
        expect(payload).toMatchObject({
          passed: 1,
          failed: 0,
          failedSuites: 1,
          runtimeErrorSuites: 1,
          success: false
        });
        expect(payload.testFiles[0]).toMatchObject({
          passed: 1,
          failed: 0,
          executionError: expect.stringContaining('ordinary afterAll configuration missing')
        });
        const collated: ICliResult = await runHeftCommandAsync(
          folder,
          ['run', '--only', 'collate', '--', '--shard-parent-folder=shards', '--shard-count=1'],
          'generation-1'
        );
        expect(collated.code).not.toBe(0);
        const report = JSON.parse(await fs.readFile(path.join(folder, 'temp', 'jest-collated.json'), 'utf8'));
        expect(report).toMatchObject({ totals: { passed: 1, failed: 0 }, success: false });
        if (provider !== 'off') {
          const coverage = JSON.parse(
            await fs.readFile(
              path.join(folder, 'temp', 'jest-collated-coverage', 'coverage-final.json'),
              'utf8'
            )
          );
          const sourceCoverage = createCoverageMap(coverage);
          expect(sourceCoverage.files()).toHaveLength(1);
          expect(sourceCoverage.getCoverageSummary().statements.covered).toBeGreaterThan(0);
        }
      }
    },
    180000
  );

  it.each(['off', 'babel', 'v8'] as const)(
    'retains completed empty-suite and setupFilesAfterEnv errors with coverage %s',
    async (provider) => {
      await fs.writeFile(path.join(folder, 'source.js'), 'module.exports = 1;\n');
      await fs.writeFile(path.join(folder, 'empty.test.js'), "require('./source');");
      await writeConfigAsync(
        folder,
        provider === 'off'
          ? {}
          : {
              collectCoverage: true,
              coverageProvider: provider,
              collectCoverageFrom: ['source.js']
            }
      );
      expect(await runHeftAsync(folder, MANAGED_ARGS)).toMatchObject({ code: 0 });
      expect(await readShardResultManifestAsync(outputFolder)).toMatchObject({ diagnosticCount: 1 });
      await fs.writeFile(
        path.join(folder, 'after-env.js'),
        "throw new Error('SIGTERM handler configuration missing');"
      );
      await writeConfigAsync(folder, {
        setupFilesAfterEnv: ['<rootDir>/after-env.js'],
        workerIdleMemoryLimit: '1GB',
        workerThreads: provider === 'v8',
        ...(provider === 'off'
          ? {}
          : {
              collectCoverage: true,
              coverageProvider: provider,
              collectCoverageFrom: ['source.js']
            })
      });
      expect(await runHeftAsync(folder, MANAGED_ARGS)).toMatchObject({ code: 0 });
      const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
      expect(manifest.diagnosticCount).toBe(1);
      expect(validateJestShardManifest(manifest)).toMatchObject({ runtimeErrorSuites: 1, success: false });
    },
    120000
  );

  it.each(['off', 'babel', 'v8'] as const)(
    'requires outer teardown after returned and rejected ordinary errors with coverage %s',
    async (provider) => {
      await fs.writeFile(path.join(folder, 'source.js'), 'module.exports = 1;\n');
      await fs.writeFile(
        path.join(folder, 'environment.cjs'),
        `
        const fs = require('node:fs');
        const { TestEnvironment } = require(${JSON.stringify(require.resolve('jest-environment-node'))});
        module.exports = class extends TestEnvironment {
          async teardown() {
            await super.teardown();
            fs.writeFileSync('teardown-reached', 'failed after Circus');
            throw new Error('ordinary teardown configuration missing');
          }
        };
      `
      );
      for (const scenario of ['afterAll', 'empty', 'afterEnv']) {
        await fs.writeFile(
          path.join(folder, 'ordinary.test.js'),
          scenario === 'empty'
            ? "require('./source');"
            : "test('completed assertion', () => expect(require('./source')).toBe(1));" +
                "afterAll(() => { throw new Error('ordinary afterAll failure'); });"
        );
        await fs.writeFile(
          path.join(folder, 'after-env.cjs'),
          "throw new Error('ordinary afterEnv failure');"
        );
        await writeConfigAsync(folder, {
          testEnvironment: '<rootDir>/environment.cjs',
          setupFilesAfterEnv: scenario === 'afterEnv' ? ['<rootDir>/after-env.cjs'] : [],
          workerIdleMemoryLimit: scenario === 'afterAll' ? undefined : '1GB',
          workerThreads: provider === 'v8',
          ...(provider === 'off'
            ? {}
            : {
                collectCoverage: true,
                coverageProvider: provider,
                collectCoverageFrom: ['source.js']
              })
        });
        const execution: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
        expect(execution.code).not.toBe(0);
        expect(execution.output).toContain('ordinary teardown configuration missing');
        expect(await fs.readFile(path.join(folder, 'teardown-reached'), 'utf8')).toBe('failed after Circus');
        await fs.unlink(path.join(folder, 'teardown-reached'));
        await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
      }
    },
    180000
  );

  it.each(['setupFiles', 'environment-setup', 'environment-teardown'] as const)(
    'does not commit %s failures outside Circus, regardless of ordinary wording',
    async (fault) => {
      await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
      if (fault === 'setupFiles') {
        await fs.writeFile(
          path.join(folder, 'setup.js'),
          "throw new Error('application configuration missing');"
        );
        await writeConfigAsync(folder, { setupFiles: ['<rootDir>/setup.js'] });
      } else {
        await fs.writeFile(
          path.join(folder, 'environment.js'),
          `const { TestEnvironment } = require(${JSON.stringify(require.resolve('jest-environment-node'))});
          module.exports = class extends TestEnvironment {
            async ${fault === 'environment-setup' ? 'setup' : 'teardown'}() {
              throw new Error('application configuration missing');
            }
          };`
        );
        await writeConfigAsync(folder, { testEnvironment: '<rootDir>/environment.js' });
      }
      const execution: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      expect(execution.code).not.toBe(0);
      expect(execution.output).toContain('application configuration missing');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    60000
  );

  it.each(['off', 'babel', 'v8'] as const)(
    'leaves no commit marker after isolated real SIGTERM and bounded-heap OOM with coverage %s',
    async (provider) => {
      for (const fault of ['terminate', 'oom'] as const) {
        // Each fatal invocation owns a distinct fixture: it must not reuse an abandoned output lock.
        const fatalFolder: string = await createFixtureAsync();
        try {
          await fs.writeFile(path.join(fatalFolder, 'source.js'), 'module.exports = 1;\n');
          await fs.writeFile(
            path.join(fatalFolder, 'fatal.test.js'),
            `test('isolated fatal ${fault}', () => {
              require('./source');
              require('node:fs').writeFileSync('fault-started', ${JSON.stringify(fault)});
              ${
                fault === 'terminate'
                  ? "process.kill(process.pid, 'SIGTERM');"
                  : 'const retained = []; for (;;) retained.push(new Array(100000).fill(1));'
              }
            });`
          );
          await writeConfigAsync(fatalFolder, {
            workerIdleMemoryLimit: '1GB',
            ...(provider === 'off'
              ? {}
              : {
                  collectCoverage: true,
                  coverageProvider: provider,
                  collectCoverageFrom: ['source.js']
                })
          });
          const execution: ICliResult = await runIsolatedJestFaultAsync(fatalFolder);
          expect(execution.code).not.toBe(0);
          expect(await fs.readFile(path.join(fatalFolder, 'fault-started'), 'utf8')).toBe(fault);
          if (fault === 'oom') {
            expect(execution.output).toMatch(
              /heap out of memory|heap limit|Managed Jest worker stopped unexpectedly \(oom\)/i
            );
          }
          await expect(
            tryReadShardResultManifestAsync(path.join(fatalFolder, 'shards', '1'))
          ).resolves.toBeUndefined();
        } finally {
          await fs.rm(fatalFolder, { recursive: true, force: true });
        }
      }
    },
    180000
  );

  it.each([false, true])(
    'does not hide a pre-Circus process exit behind Jest worker retries (threads=%s)',
    async (workerThreads) => {
      await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
      await fs.writeFile(
        path.join(folder, 'environment.js'),
        `const fs = require('node:fs');
      if (!fs.existsSync('first-attempt')) {
        fs.writeFileSync('first-attempt', 'started');
        process.exit(7);
      }
      module.exports = require(${JSON.stringify(require.resolve('jest-environment-node'))}).TestEnvironment;`
      );
      // This normally selects Jest's retrying worker pool despite maxWorkers=1.
      await writeConfigAsync(folder, {
        testEnvironment: '<rootDir>/environment.js',
        workerIdleMemoryLimit: '1GB',
        workerThreads
      });
      const execution: ICliResult = await runIsolatedJestFaultAsync(folder);
      expect(execution.code).not.toBe(0);
      expect(await fs.readFile(path.join(folder, 'first-attempt'), 'utf8')).toBe('started');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    60000
  );

  it.each([
    ['default-serial', false, undefined, false],
    ['explicit-serial', true, '1KB', true],
    ['process-reuse', false, '1GB', false],
    ['process-recycle', false, '1KB', false],
    ['thread-reuse', false, '1GB', true],
    ['thread-recycle', false, '1KB', true]
  ] as const)(
    'preserves first/next suite startup and output in %s mode',
    async (mode, detectOpenHandles, workerIdleMemoryLimit, workerThreads) => {
      for (let index: number = 0; index < 3; index++) {
        await fs.writeFile(
          path.join(folder, `suite-${index}.test.js`),
          `const { threadId, isMainThread } = require('node:worker_threads');
          test('suite ${index}', () => {
            expect(process.env.JEST_WORKER_ID).toBe('1');
            require('node:fs').appendFileSync('identities',
              JSON.stringify({ pid: process.pid, threadId, isMainThread }) + '\\n');
            console.log('buffered stdout ${index}');
            console.error('buffered stderr ${index}');
          });`
        );
      }
      await writeConfigAsync(folder, {
        workerIdleMemoryLimit,
        workerThreads,
        detectOpenHandles
      });
      const execution: ICliResult = await runHeftAsync(
        folder,
        detectOpenHandles ? [...MANAGED_ARGS, '--detect-open-handles'] : MANAGED_ARGS
      );
      expect(execution).toEqual({ code: 0, output: expect.stringContaining('verdict deferred') });
      const identities: IWorkerIdentity[] = (await fs.readFile(path.join(folder, 'identities'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(identities).toHaveLength(3);
      const serial: boolean = mode.endsWith('serial');
      expect(new Set(identities.map(({ pid, threadId }) => `${pid}:${threadId}`)).size).toBe(
        mode.endsWith('recycle') ? 3 : 1
      );
      for (const identity of identities) {
        expect(identity.isMainThread).toBe(serial || !workerThreads);
      }
      for (let index: number = 0; index < 3; index++) {
        expect(execution.output).toContain(`buffered stdout ${index}`);
        expect(execution.output).toContain(`buffered stderr ${index}`);
      }
      expect(await readShardResultManifestAsync(outputFolder)).toMatchObject({
        itemCount: 3,
        diagnosticCount: 0
      });
    },
    120000
  );

  it.each([
    [false, 'bootstrap'],
    [true, 'bootstrap'],
    [false, 'runtime'],
    [true, 'runtime']
  ] as const)(
    'allows slow recycled worker startup before graceful shutdown (threads=%s, delay=%s)',
    async (workerThreads, delay) => {
      const preload: string = path.join(folder, 'slow-worker.cjs');
      await fs.writeFile(
        preload,
        `
        if (typeof process.send === 'function' || !require('node:worker_threads').isMainThread) {
          ${
            delay === 'bootstrap'
              ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);'
              : `
            const Module = require('node:module');
            const load = Module._load;
            let delayed = false;
            Module._load = function(request, ...args) {
              if (!delayed && request === 'jest-runtime') {
                delayed = true;
                require('node:fs').appendFileSync('runtime-starts', 'start\\n');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
                require('node:fs').appendFileSync('runtime-finishes', 'done\\n');
              }
              return load.call(this, request, ...args);
            };
          `
          }
          require('node:fs').appendFileSync('bootstraps', 'ready\\n');
        }
      `
      );
      for (let index: number = 0; index < 3; index++) {
        await fs.writeFile(
          path.join(folder, `suite-${index}.test.js`),
          `test('suite ${index}', () => {
            require('node:fs').appendFileSync('completed-suites', 'done\\n');
          });`
        );
      }
      await writeConfigAsync(folder, { workerThreads, workerIdleMemoryLimit: '1KB' });
      const execution: ICliResult = await runIsolatedJestFaultAsync(folder, ['--require', preload]);
      expect(execution).toEqual({ code: 0, output: expect.stringContaining('verdict deferred') });
      expect(
        (await fs.readFile(path.join(folder, 'completed-suites'), 'utf8')).trim().split('\n')
      ).toHaveLength(3);
      expect((await fs.readFile(path.join(folder, 'bootstraps'), 'utf8')).trim().split('\n')).toHaveLength(4);
      if (delay === 'runtime') {
        expect(
          (await fs.readFile(path.join(folder, 'runtime-starts'), 'utf8')).trim().split('\n')
        ).toHaveLength(3);
        expect(
          (await fs.readFile(path.join(folder, 'runtime-finishes'), 'utf8')).trim().split('\n')
        ).toHaveLength(3);
      }
      expect(await readShardResultManifestAsync(outputFolder)).toMatchObject({
        itemCount: 3,
        diagnosticCount: 0
      });
    },
    120000
  );

  it.each([
    ['exit-zero', false],
    ['exit-seven', false],
    ['oom', false],
    ['exit-zero', true],
    ['exit-seven', true],
    ['oom', true]
  ] as const)(
    'rejects %s before the worker module loads, without an invisible passing retry (threads=%s)',
    async (fault, workerThreads) => {
      await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
      const preload: string = path.join(folder, 'preload.cjs');
      await fs.writeFile(
        preload,
        `
        if (typeof process.send === 'function' || !require('node:worker_threads').isMainThread) {
          const fs = require('node:fs');
          const first = !fs.existsSync('boot-attempts');
          fs.appendFileSync('boot-attempts', 'started\\n');
          if (first) {
            ${
              fault === 'oom'
                ? 'const retained = []; for (;;) retained.push(new Array(100000).fill(1));'
                : `process.exit(${fault === 'exit-zero' ? 0 : 7});`
            }
          }
        }
      `
      );
      await writeConfigAsync(folder, { workerIdleMemoryLimit: '1GB', workerThreads });
      const execution: ICliResult = await runIsolatedJestFaultAsync(folder, ['--require', preload]);
      expect(execution.code).not.toBe(0);
      expect(await fs.readFile(path.join(folder, 'boot-attempts'), 'utf8')).toBe('started\n');
      expect(Number(await fs.readFile(path.join(folder, 'fault-host-survived'), 'utf8'))).toBeGreaterThan(0);
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    90000
  );

  it.each([false, true])(
    'cancels only the active owned worker and cleans its receipts (threads=%s)',
    async (workerThreads) => {
      await fs.writeFile(
        path.join(folder, 'hang.test.js'),
        `
      test('awaits cancellation', async () => {
        const fs = require('node:fs');
        setInterval(() => fs.appendFileSync('worker-heartbeat', 'tick\\n'), 10);
        fs.writeFileSync('worker-ready', 'ready');
        await new Promise(() => {});
      }, 60000);
    `
      );
      await writeConfigAsync(folder, { workerIdleMemoryLimit: '1GB', workerThreads });
      const execution: ICliResult = await runIsolatedJestFaultAsync(folder, [], 'worker-ready');
      expect(execution.code).not.toBe(0);
      expect(execution.output).toContain('Cancelled active managed Jest worker');
      expect(await fs.readFile(path.join(folder, 'worker-ready'), 'utf8')).toBe('ready');
      expect(Number(await fs.readFile(path.join(folder, 'fault-host-survived'), 'utf8'))).toBeGreaterThan(0);
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
      const { getShardTempFolderPath } = await import('@rushstack/heft/lib/sharding/ShardIdentity');
      const receipts: string = path.join(
        getShardTempFolderPath(path.join(folder, 'temp', 'test', 'jest'), { shardIndex: 1, shardCount: 1 }),
        'suite-completion'
      );
      const stages: string[] = await fs.readdir(receipts, { recursive: true });
      expect(stages.some((filename) => filename.endsWith('.json'))).toBe(false);
    },
    90000
  );

  it.each([false, true])(
    'supervises startup, idle and final-result exit-zero across controlled reporter barriers (threads=%s)',
    async (workerThreads) => {
      for (const interval of ['startup', 'idle', 'final-idle']) {
        const fatalFolder: string = await createFixtureAsync();
        try {
          const preload: string = path.join(fatalFolder, 'barrier-preload.cjs');
          await fs.writeFile(
            preload,
            `
            const fs = require('node:fs');
            const threads = require('node:worker_threads');
            if (typeof process.send === 'function' || !threads.isMainThread) {
              const first = !fs.existsSync('boot-attempts');
              fs.appendFileSync('boot-attempts', 'started\\n');
              if (${JSON.stringify(interval)} === 'startup' && first) {
                fs.writeFileSync('fault-started', 'startup exit zero');
                process.exit(0);
              }
            } else {
              // Observe real child/thread exit events at the public Node boundary. The reporter
              // explicitly waits for exit, never a timing guess, before allowing another task.
              const observe = worker => {
                global.__fixtureWorkerExit = new Promise(resolve => worker.once('exit', resolve));
                return worker;
              };
              const childProcess = require('node:child_process');
              const fork = childProcess.fork;
              childProcess.fork = (...args) => observe(fork(...args));
              const Thread = threads.Worker;
              threads.Worker = class extends Thread {
                constructor(...args) { super(...args); observe(this); }
              };
              const Reporter = require(${JSON.stringify(require.resolve('../HeftJestReporter'))}).default;
              const barrier = new (require('./barrier-reporter.cjs'))();
              for (const method of ['onTestStart', 'onTestResult']) {
                const original = Reporter.prototype[method];
                Reporter.prototype[method] = async function(...args) {
                  await original.apply(this, args);
                  await barrier[method]();
                };
              }
            }
          `
          );
          await fs.writeFile(
            path.join(fatalFolder, 'barrier-reporter.cjs'),
            `
            const fs = require('node:fs');
            module.exports = class {
              async onTestStart() {
                if (${JSON.stringify(interval)} === 'startup') {
                  fs.writeFileSync('reporter-barrier', global.__fixtureWorkerExit ? 'worker exists' : 'no worker yet');
                  if (global.__fixtureWorkerExit) await global.__fixtureWorkerExit;
                }
              }
              async onTestResult() {
                if (${JSON.stringify(interval)} !== 'startup') {
                  fs.writeFileSync('idle-exit-allowed', 'reporter waiting');
                  await global.__fixtureWorkerExit;
                  fs.writeFileSync('reporter-barrier', 'observed idle exit');
                }
              }
            };
          `
          );
          await fs.writeFile(
            path.join(fatalFolder, 'environment.cjs'),
            `
            const fs = require('node:fs');
            const { TestEnvironment } = require(${JSON.stringify(require.resolve('jest-environment-node'))});
            module.exports = class extends TestEnvironment {
              async teardown() {
                await super.teardown();
                if (${JSON.stringify(interval)} !== 'startup') {
                  const timer = setInterval(() => {
                    if (fs.existsSync('idle-exit-allowed')) {
                      clearInterval(timer);
                      fs.writeFileSync('fault-started', ${JSON.stringify(`${interval} exit zero`)});
                      process.exit(0);
                    }
                  }, 10);
                }
              }
            };
          `
          );
          for (const name of interval === 'final-idle' ? ['first'] : ['first', 'second']) {
            await fs.writeFile(
              path.join(fatalFolder, `${name}.test.js`),
              `
              test('completed suite', () => {
                require('node:fs').appendFileSync('suite-attempts', 'passed\\n');
                expect(1).toBe(1);
              });
            `
            );
          }
          await writeConfigAsync(fatalFolder, {
            workerIdleMemoryLimit: '1GB',
            workerThreads,
            testEnvironment: '<rootDir>/environment.cjs'
          });
          const execution: ICliResult = await runIsolatedJestFaultAsync(fatalFolder, ['--require', preload]);
          expect(execution.code).not.toBe(0);
          expect(execution.output).toMatch(
            /Managed Jest worker stopped unexpectedly|crashed for an unknown reason|thread exited unexpectedly/
          );
          expect(await fs.readFile(path.join(fatalFolder, 'fault-started'), 'utf8')).toBe(
            `${interval} exit zero`
          );
          expect(await fs.readFile(path.join(fatalFolder, 'boot-attempts'), 'utf8')).toBe('started\n');
          expect(await fs.readFile(path.join(fatalFolder, 'reporter-barrier'), 'utf8')).toBe(
            interval === 'startup' ? 'no worker yet' : 'observed idle exit'
          );
          if (interval === 'startup') {
            await expect(fs.stat(path.join(fatalFolder, 'suite-attempts'))).rejects.toThrow(/ENOENT/);
          } else {
            expect(await fs.readFile(path.join(fatalFolder, 'suite-attempts'), 'utf8')).toBe('passed\n');
          }
          expect(
            Number(await fs.readFile(path.join(fatalFolder, 'fault-host-survived'), 'utf8'))
          ).toBeGreaterThan(0);
          await expect(
            tryReadShardResultManifestAsync(path.join(fatalFolder, 'shards', '1'))
          ).resolves.toBeUndefined();
        } finally {
          await fs.rm(fatalFolder, { recursive: true, force: true });
        }
      }
    },
    180000
  );

  it.each([false, true])(
    'fails instead of hanging when the final worker exits before reporting memory (threads=%s)',
    async (workerThreads) => {
      const fatalFolder: string = await createFixtureAsync();
      try {
        const preload: string = path.join(fatalFolder, 'memory-exit-preload.cjs');
        await fs.writeFile(
          preload,
          `
          const threads = require('node:worker_threads');
          const exitOnMemoryRequest = message => {
            if (Array.isArray(message) && message[0] === 3) process.exit(0);
          };
          if (typeof process.send === 'function') {
            process.prependListener('message', exitOnMemoryRequest);
          } else if (!threads.isMainThread) {
            threads.parentPort.prependListener('message', exitOnMemoryRequest);
          }
        `
        );
        await fs.writeFile(
          path.join(fatalFolder, 'pass.test.js'),
          "test('passes', () => expect(1).toBe(1));"
        );
        await writeConfigAsync(fatalFolder, { workerIdleMemoryLimit: '1GB', workerThreads });
        const execution: ICliResult = await runIsolatedJestFaultAsync(
          fatalFolder,
          ['--require', preload],
          '',
          60000
        );
        expect(execution.code).not.toBe(0);
        expect(execution.output).toContain(
          workerThreads
            ? 'Call retries were exceeded'
            : 'Managed Jest worker stopped before reporting final memory usage (shut-down).'
        );
        await expect(
          tryReadShardResultManifestAsync(path.join(fatalFolder, 'shards', '1'))
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(fatalFolder, { recursive: true, force: true });
      }
    },
    90000
  );

  it('rejects global lifecycle hooks before constructing managed workers', async () => {
    await fs.writeFile(
      path.join(folder, 'setup.cjs'),
      `
      module.exports = () => {
        global.__fixtureSetup = process.pid;
        require('node:fs').appendFileSync('lifecycle', 'setup\\n');
      };
    `
    );
    await fs.writeFile(
      path.join(folder, 'teardown.cjs'),
      `
      module.exports = () => {
        if (global.__fixtureSetup !== process.pid) throw new Error('Lost parent lifecycle');
        require('node:fs').appendFileSync('lifecycle', 'teardown\\n');
      };
    `
    );
    await fs.writeFile(
      path.join(folder, 'thread.test.js'),
      `
      test('real thread with user globals', () => {
        const { isMainThread } = require('node:worker_threads');
        expect(isMainThread).toBe(false);
        expect(global.fixtureGlobals).toEqual({ nested: { values: ['preserved', 17] } });
        require('node:fs').writeFileSync('thread-scenario', 'executed');
        console.log('parent reporter received thread result');
      });
    `
    );
    await writeConfigAsync(folder, {
      workerIdleMemoryLimit: '1GB',
      workerThreads: true,
      globalSetup: '<rootDir>/setup.cjs',
      globalTeardown: '<rootDir>/teardown.cjs',
      globals: { fixtureGlobals: { nested: { values: ['preserved', 17] } } }
    });
    const execution: ICliResult = await runJestTaskHookInChildAsync(folder, 'callback-logger');
    expect(execution.code).not.toBe(0);
    expect(execution.output).toContain('does not support "globalSetup"');
    await expect(fs.stat(path.join(folder, 'thread-scenario'))).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(path.join(folder, 'lifecycle'))).rejects.toThrow(/ENOENT/);
    await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
  }, 60000);

  it('rejects globalSetup before constructing any owned thread', async () => {
    const preload: string = path.join(folder, 'observe-thread.cjs');
    await fs.writeFile(
      preload,
      `
      const threads = require('node:worker_threads');
      const Thread = threads.Worker;
      threads.Worker = class extends Thread {
        constructor(...args) {
          require('node:fs').writeFileSync('thread-created', 'created');
          super(...args);
        }
      };
    `
    );
    await fs.writeFile(
      path.join(folder, 'setup.cjs'),
      `
      module.exports = (globalConfig, project) => {
        project.globals.nonCloneable = () => 'must not silently strip user globals';
        require('node:fs').writeFileSync('fault-started', 'non-cloneable global');
      };
    `
    );
    await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
    await writeConfigAsync(folder, {
      workerIdleMemoryLimit: '1GB',
      workerThreads: true,
      globalSetup: '<rootDir>/setup.cjs'
    });
    const execution: ICliResult = await runIsolatedJestFaultAsync(folder, ['--require', preload]);
    expect(execution.code).not.toBe(0);
    expect(execution.output).toContain('does not support "globalSetup"');
    await expect(fs.stat(path.join(folder, 'fault-started'))).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(path.join(folder, 'thread-created'))).rejects.toThrow(/ENOENT/);
    expect(Number(await fs.readFile(path.join(folder, 'fault-host-survived'), 'utf8'))).toBeGreaterThan(0);
    await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
  }, 60000);

  it.each(['missing', 'digest', 'stale'] as const)(
    'does not publish after an environment leaves %s completion evidence',
    async (fault) => {
      await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
      await fs.writeFile(
        path.join(folder, 'environment.js'),
        `const fs = require('node:fs');
        const { createHash, randomUUID } = require('node:crypto');
        const { TestEnvironment } = require(${JSON.stringify(require.resolve('jest-environment-node'))});
        const { getCompletionReceiptPath } = require(${JSON.stringify(
          require.resolve('@rushstack/heft-jest-plugin/lib/JestCompletionEvidence')
        )});
        module.exports = class extends TestEnvironment {
          constructor(config, context) {
            super(config, context);
            this.receipt = getCompletionReceiptPath(config.projectConfig, context.testPath, 'settled');
          }
          async teardown() {
            await super.teardown();
            const fault = ${JSON.stringify(fault)};
            if (fault === 'missing') {
              fs.unlinkSync(this.receipt);
            } else {
              const envelope = JSON.parse(fs.readFileSync(this.receipt, 'utf8'));
              if (fault === 'digest') envelope.sha256 = '0'.repeat(64);
              else {
                const receipt = JSON.parse(envelope.payload);
                receipt.attempt = randomUUID();
                envelope.payload = JSON.stringify(receipt);
                envelope.sha256 = createHash('sha256').update(envelope.payload).digest('hex');
              }
              fs.writeFileSync(this.receipt, JSON.stringify(envelope));
            }
          }
        };`
      );
      await writeConfigAsync(folder, { testEnvironment: '<rootDir>/environment.js' });
      const execution: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      expect(execution.code).not.toBe(0);
      expect(execution.output).toContain(
        fault === 'missing'
          ? 'ENOENT'
          : fault === 'digest'
            ? 'Corrupt Jest completion receipt'
            : 'Stale or inconsistent Jest completion receipt'
      );
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    60000
  );

  it.each(['babel', 'v8'] as const)(
    'does not commit an ordinary suite failure if %s coverage recovery cannot finish',
    async (provider) => {
      await fs.writeFile(path.join(folder, 'source.js'), 'module.exports = 1;\n');
      await fs.writeFile(
        path.join(folder, 'import.test.js'),
        "require('./source'); throw new Error('application configuration missing');"
      );
      await fs.writeFile(
        path.join(folder, 'environment.js'),
        `const fs = require('node:fs');
        const { TestEnvironment } = require(${JSON.stringify(require.resolve('jest-environment-node'))});
        const { getRuntimeCoveragePath } = require(${JSON.stringify(
          require.resolve('@rushstack/heft-jest-plugin/lib/JestCoverageRunner')
        )});
        const { getCompletionAttempt } = require(${JSON.stringify(
          require.resolve('@rushstack/heft-jest-plugin/lib/JestCompletionEvidence')
        )});
        module.exports = class extends TestEnvironment {
          constructor(config, context) {
            super(config, context);
            const project = config.projectConfig;
            this.receipt = getRuntimeCoveragePath(project, getCompletionAttempt(project), context.testPath);
          }
          async teardown() {
            await super.teardown();
            if (fs.existsSync(this.receipt)) fs.unlinkSync(this.receipt);
            fs.mkdirSync(this.receipt, { recursive: true });
          }
        };`
      );
      await writeConfigAsync(folder, {
        testEnvironment: '<rootDir>/environment.js',
        collectCoverage: true,
        coverageProvider: provider,
        collectCoverageFrom: ['source.js']
      });
      const execution: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      expect(execution.code).not.toBe(0);
      expect(execution.output).toContain('Invalid runtime coverage recovery file');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    60000
  );

  it('rejects globalTeardown before committing a managed manifest', async () => {
    await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
    await fs.writeFile(
      path.join(folder, 'teardown.js'),
      `const fs = require('node:fs');
      const path = require('node:path');
      const { getCompletionReceiptPath } = require(${JSON.stringify(
        require.resolve('@rushstack/heft-jest-plugin/lib/JestCompletionEvidence')
      )});
      module.exports = (globalConfig, project) => {
        fs.linkSync(
          getCompletionReceiptPath(project, path.join(project.rootDir, 'pass.test.js'), 'completed'),
          path.join(project.rootDir, 'receipt-link')
        );
      };`
    );
    await writeConfigAsync(folder, { globalTeardown: '<rootDir>/teardown.js' });
    const execution: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(execution.code).not.toBe(0);
    expect(execution.output).toContain('does not support "globalTeardown"');
    await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
  }, 60000);

  it('writes a valid manifest for an empty partition', async () => {
    const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(result).toEqual({ code: 0, output: expect.any(String) });
    const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
    expect(manifest.itemCount).toBe(0);
    expect(validateJestShardManifest(manifest).testFiles).toEqual([]);
  }, 60000);

  it.each([{ args: [] }, { args: ['--shard=1/1'] }, { args: MANAGED_ARGS }])(
    'preserves passing runs: $args',
    async ({ args }) => {
      await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => expect(1).toBe(1));");
      const result: ICliResult = await runHeftAsync(folder, args);
      expect(result).toEqual({ code: 0, output: expect.any(String) });
      if (args === MANAGED_ARGS) {
        const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
        expect(manifest).toMatchObject({ itemCount: 1, diagnosticCount: 0 });
        expect(validateJestShardManifest(manifest).success).toBe(true);
      } else {
        expect(result.output).toContain('Tests finished:');
        expect(result.output).not.toContain('verdict deferred');
      }
    },
    60000
  );

  it('preserves an existing mismatched snapshot without rewriting it', async () => {
    await fs.mkdir(path.join(folder, '__snapshots__'));
    const snapshotPath: string = path.join(folder, '__snapshots__', 'snapshot.test.js.snap');
    const snapshot: string =
      '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing\n\nexports[`snapshot 1`] = `"old"`;\n';
    await fs.writeFile(snapshotPath, snapshot);
    await fs.writeFile(
      path.join(folder, 'snapshot.test.js'),
      "test('snapshot', () => expect('new').toMatchSnapshot());"
    );
    const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(result).toEqual({ code: 0, output: expect.any(String) });
    const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
    expect(validateJestShardManifest(manifest)).toMatchObject({ failed: 1, snapshotFailure: true });
    expect(await fs.readFile(snapshotPath, 'utf8')).toBe(snapshot);
  }, 60000);

  it('records obsolete snapshots as diagnostics without deleting them', async () => {
    await fs.mkdir(path.join(folder, '__snapshots__'));
    const snapshotPath: string = path.join(folder, '__snapshots__', 'deleted.test.js.snap');
    const snapshot: string =
      '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing\n\nexports[`deleted 1`] = `"old"`;\n';
    await fs.writeFile(snapshotPath, snapshot);
    await fs.writeFile(path.join(folder, 'passing.test.js'), "test('passes', () => expect(1).toBe(1));");
    const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(result).toEqual({ code: 0, output: expect.any(String) });
    const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
    expect(validateJestShardManifest(manifest)).toMatchObject({ passed: 1, snapshotFailure: true });
    expect(manifest.diagnosticCount).toBeGreaterThan(0);
    expect(await fs.readFile(snapshotPath, 'utf8')).toBe(snapshot);
  }, 60000);

  it('does not count skipped or todo cases as executed work', async () => {
    await fs.writeFile(
      path.join(folder, 'skipped.test.js'),
      "test.skip('skip', () => {}); test.todo('todo');"
    );
    const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(result).toEqual({ code: 0, output: expect.any(String) });
    const manifest: IShardResultManifest = await readShardResultManifestAsync(outputFolder);
    expect(manifest.itemCount).toBe(0);
    expect(validateJestShardManifest(manifest)).toMatchObject({ skipped: 1, todo: 1 });
  }, 60000);

  it.each(['', '  '])(
    'requires a nonempty managed generation (%j)',
    async (generation) => {
      const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS, generation);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('RUSH_SHARD_GENERATION');
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    60000
  );

  it.each(['.', '..', '../outside/1', 'shards/2'])(
    'rejects unsafe output directory %s',
    async (output) => {
      const result: ICliResult = await runHeftAsync(folder, [
        '--shard=1/1',
        `--shard-output-directory=${output}`
      ]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('must be below the build folder');
    },
    60000
  );

  it.each(['config', 'setup', 'abort'])(
    'invalidates only the old marker before %s harness failure',
    async (failure) => {
      await fs.mkdir(outputFolder, { recursive: true });
      await fs.writeFile(getShardManifestPath(outputFolder), '{"previous":"success"}');
      await fs.writeFile(path.join(outputFolder, 'keep.json'), '{}');
      const sibling: string = path.join(folder, 'shards', '2');
      await fs.mkdir(sibling);
      await fs.writeFile(getShardManifestPath(sibling), 'sibling');
      await fs.writeFile(path.join(folder, 'pass.test.js'), "test('passes', () => {});");
      if (failure === 'config') {
        await fs.writeFile(path.join(folder, 'config', 'jest.config.json'), '{ bad config');
      } else {
        await fs.writeFile(
          path.join(folder, 'setup.js'),
          failure === 'setup'
            ? "module.exports = () => { throw new Error('setup failed'); };"
            : 'process.exit(7);'
        );
        await writeConfigAsync(folder, { setupFiles: ['<rootDir>/setup.js'] });
      }
      const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      expect(result.code).not.toBe(0);
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
      expect(await fs.readFile(path.join(outputFolder, 'keep.json'), 'utf8')).toBe('{}');
      expect(await fs.readFile(getShardManifestPath(sibling), 'utf8')).toBe('sibling');
    },
    60000
  );

  it('propagates manifest publication failure rather than deferring the verdict', async () => {
    await fs.writeFile(
      path.join(folder, 'publication.test.js'),
      "const fs = require('fs'); const path = require('path'); " +
        "test('blocks commit marker', () => { fs.mkdirSync(path.join(__dirname, 'shards', '1', " +
        "'shard-manifest.json'), { recursive: true }); });"
    );
    const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
    expect(result.code).not.toBe(0);
    expect(await fs.readdir(outputFolder)).toEqual(['shard-manifest.json']);
  }, 60000);

  it.each(['reporters', 'testResultsProcessor', 'projects', 'preset', 'coverageThreshold'])(
    'rejects unsupported managed %s instead of hiding its correctness checks',
    async (property) => {
      await fs.writeFile(path.join(folder, 'custom.js'), 'module.exports = class CustomReporter {};');
      const config: Record<string, unknown> = {
        [property]:
          property === 'reporters'
            ? ['<rootDir>/custom.js']
            : property === 'projects'
              ? ['<rootDir>']
              : property === 'coverageThreshold'
                ? { global: { lines: 90 } }
                : '<rootDir>/custom.js'
      };
      await writeConfigAsync(folder, config);
      const result: ICliResult = await runHeftAsync(folder, MANAGED_ARGS);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(property === 'reporters' ? 'Custom reporters' : property);
      await expect(tryReadShardResultManifestAsync(outputFolder)).resolves.toBeUndefined();
    },
    60000
  );
});

describe('Jest shard payload validation and cancellation', () => {
  let folder: string;
  let results: AggregatedResult;
  let execution: IJestShardExecution | undefined;

  afterEach(() => {
    execution?.lock.release();
    execution = undefined;
  });

  beforeAll(async () => {
    folder = await createFixtureAsync();
    await fs.writeFile(path.join(folder, 'assertions.test.js'), FAILURE_TESTS);
    await fs.writeFile(
      path.join(folder, 'processor.js'),
      "module.exports = results => { require('fs').writeFileSync(require('path').join(__dirname, " +
        "'aggregate.json'), JSON.stringify(results)); return results; };"
    );
    await writeConfigAsync(folder, { testResultsProcessor: '<rootDir>/processor.js' });
    const result: ICliResult = await runHeftAsync(folder, ['--shard=1/1']);
    expect(result.code).not.toBe(0);
    results = JSON.parse(await fs.readFile(path.join(folder, 'aggregate.json'), 'utf8'));
  }, 60000);

  afterAll(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('rejects missing assertion and suite results', () => {
    expect(() => createJestShardPayload({ ...results, testResults: [] }, folder)).toThrow(/every scheduled/);
    const missingAssertions: AggregatedResult = structuredClone(results);
    missingAssertions.testResults[0].testResults = [];
    expect(() => createJestShardPayload(missingAssertions, folder)).toThrow(/Missing Jest assertion/);
  });

  it('does not discard collected coverage when its managed contract is missing', () => {
    expect(() => createJestShardPayload({ ...results, coverageMap: createCoverageMap({}) }, folder)).toThrow(
      /coverage contract disagree/
    );
  });

  it('records an unexplained Jest failure rather than manufacturing success', async () => {
    execution = await prepareJestShardExecutionAsync(
      folder,
      'shards/1',
      { shardIndex: 1, shardCount: 1 },
      'generation'
    );
    const unexplained: AggregatedResult = {
      ...results,
      testResults: [],
      numTotalTestSuites: 0,
      numFailedTestSuites: 0,
      numRuntimeErrorTestSuites: 0,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: false,
      snapshot: { ...results.snapshot, failure: false, unmatched: 0 }
    };
    const manifest: IShardResultManifest = await completeJestShardExecutionAsync(
      execution,
      unexplained,
      new AbortController().signal
    );
    expect(manifest.diagnosticCount).toBe(1);
    expect(validateJestShardManifest(manifest).failureReasons).toEqual(['jest-unsuccessful']);
  });

  it('rejects symlinked output and missing generation before trusting an old marker', async () => {
    const actual: string = path.join(folder, 'actual');
    await fs.mkdir(path.join(actual, '1'), { recursive: true });
    await fs.writeFile(getShardManifestPath(path.join(actual, '1')), 'preserve');
    await fs.symlink(actual, path.join(folder, 'linked'), 'junction');
    await expect(
      prepareJestShardExecutionAsync(folder, 'linked/1', { shardIndex: 1, shardCount: 1 }, 'generation')
    ).rejects.toThrow(/symbolic link/);
    expect(await fs.readFile(getShardManifestPath(path.join(actual, '1')), 'utf8')).toBe('preserve');
    await expect(
      prepareJestShardExecutionAsync(folder, 'actual/1', { shardIndex: 1, shardCount: 1 }, undefined)
    ).rejects.toThrow(/RUSH_SHARD_GENERATION/);
    await expect(tryReadShardResultManifestAsync(path.join(actual, '1'))).resolves.toBeUndefined();
  });

  it('rejects interrupted, run execution error, and worker OOM results', () => {
    expect(() => createJestShardPayload({ ...results, wasInterrupted: true }, folder)).toThrow(/interrupted/);
    expect(() =>
      createJestShardPayload(
        {
          ...results,
          runExecError: { message: 'harness', stack: '', type: 'Error' }
        },
        folder
      )
    ).toThrow(/harness/);
    const oom: AggregatedResult = structuredClone(results);
    oom.testResults[0].testExecError = { message: 'worker out of memory', stack: '', type: 'WorkerError' };
    expect(() => createJestShardPayload(oom, folder)).toThrow(/infrastructure/);
    oom.testResults[0].testExecError = {
      message: 'A jest worker process (pid=1) crashed for an unknown reason: exitCode=7',
      stack: 'A stack that omits the original message',
      type: 'Error'
    };
    expect(() => createJestShardPayload(oom, folder)).toThrow(/infrastructure/);
  });

  it('never commits after Heft cancellation', async () => {
    execution = await prepareJestShardExecutionAsync(
      folder,
      'shards/1',
      { shardIndex: 1, shardCount: 1 },
      'generation'
    );
    const controller: AbortController = new AbortController();
    controller.abort();
    await expect(completeJestShardExecutionAsync(execution, results, controller.signal)).rejects.toThrow();
    await expect(tryReadShardResultManifestAsync(execution.outputFolderPath)).resolves.toBeUndefined();
  });

  it('validates JSON counts, identities, duplicates, and manifest counters for I7', async () => {
    execution = await prepareJestShardExecutionAsync(
      folder,
      'shards/1',
      { shardIndex: 1, shardCount: 1 },
      'generation'
    );
    const manifest: IShardResultManifest = await completeJestShardExecutionAsync(
      execution,
      results,
      new AbortController().signal
    );
    const payload: IJestShardPayload = validateJestShardManifest(manifest);
    expect(() => validateJestShardPayload({ ...payload, passed: 1.5 })).toThrow(/JSON validation/);
    expect(() => validateJestShardPayload({ ...payload, passed: payload.passed + 1 })).toThrow(/counters/);
    expect(() => validateJestShardManifest({ ...manifest, itemCount: manifest.itemCount + 1 })).toThrow(
      /counters/
    );
    expect(() => validateJestShardManifest({ ...manifest, payload: undefined })).toThrow();
    const duplicates: Set<string> = new Set();
    validateJestShardManifest(manifest, duplicates);
    expect(() => validateJestShardManifest(manifest, duplicates)).toThrow(/Duplicate/);
    for (const invalid of ['../outside.js', '/absolute.js', 'C:/absolute.js', 'a\\b.js', './a.js']) {
      const changed: IJestShardPayload = structuredClone(payload);
      changed.testFiles[0].path = invalid;
      expect(() => validateJestShardPayload(changed)).toThrow(/identity/);
    }
    expect(() =>
      validateJestShardPayload({
        ...payload,
        testFiles: [...payload.testFiles, payload.testFiles[0]]
      })
    ).toThrow(/duplicate/);
  });
});
