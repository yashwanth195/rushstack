// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'node:path';
import { createEmptyTestResult, makeEmptyAggregatedTestResult } from '@jest/test-result';
import type { IShardResultManifest } from '@rushstack/heft/lib/sharding/IShardResultManifest';
import { validateShardResults } from '@rushstack/heft/lib/sharding/ShardCollation';

import { disabledJestCoverage } from '../JestCoverage';
import { mergeJestShardResults, type IJestCollatedReport } from '../JestCollation';
import { serializeJestJUnitReport } from '../JestJUnitReporting';
import {
  createJestShardPayload,
  getJestShardCounts,
  validateJestShardPayload,
  type IJestShardAssertion,
  type IJestShardPayload
} from '../JestShardPayload';

function fixture(
  statuses: IJestShardAssertion['status'][] = ['passed', 'failed', 'pending', 'skipped', 'disabled', 'todo']
): { payload: IJestShardPayload; report: IJestCollatedReport } {
  const assertions: IJestShardAssertion[] = statuses.map((status) => ({
    title: status,
    fullName: `group ${status}`,
    ancestorTitles: ['group'],
    status,
    durationMs: status === 'passed' ? 1250 : null,
    failureMessages: status === 'failed' ? ['actual <failure> & "detail"'] : []
  }));
  const counts = {
    passed: statuses.filter((status) => status === 'passed').length,
    failed: statuses.filter((status) => status === 'failed').length,
    skipped: statuses.filter((status) => ['pending', 'skipped', 'disabled'].includes(status)).length,
    todo: statuses.filter((status) => status === 'todo').length
  };
  const payload: IJestShardPayload = {
    version: 3,
    passWithNoTests: true,
    coverage: disabledJestCoverage(),
    ...counts,
    failedSuites: counts.failed ? 1 : 0,
    runtimeErrorSuites: 0,
    snapshotFailure: false,
    success: counts.failed === 0,
    failureReasons: counts.failed ? ['failed-tests', 'failed-suites', 'jest-unsuccessful'] : [],
    testFiles: [
      {
        path: 'example.test.js',
        ...counts,
        failureMessage: null,
        executionError: null,
        snapshotFailure: false,
        failures: assertions
          .filter((assertion) => assertion.status === 'failed')
          .map((assertion) => ({
            testName: assertion.fullName,
            messages: assertion.failureMessages
          })),
        assertions
      }
    ]
  };
  const manifest: IShardResultManifest = {
    version: 1,
    workload: 'jest',
    status: 'completed',
    generation: 'generation',
    producerAttempt: 'attempt',
    shardIndex: 1,
    shardCount: 1,
    startedAt: '2026-09-14T00:00:00.000Z',
    durationMs: 1250,
    ...getJestShardCounts(payload),
    payload
  };
  return { payload, report: mergeJestShardResults(validateShardResults([manifest], 1)) };
}

describe('collator-owned JUnit', () => {
  it('uses every real test identity and outcome, with milliseconds converted to seconds', () => {
    const xml = serializeJestJUnitReport(fixture().report);
    expect(xml).toContain('<testsuites tests="6" failures="1" errors="0" skipped="4">');
    expect(xml.match(/<testcase /g)).toHaveLength(6);
    expect(xml).toContain('name="group passed" classname="group" file="example.test.js" time="1.25"');
    expect(xml).toContain('actual &lt;failure&gt; &amp; &quot;detail&quot;');
    for (const status of ['pending', 'skipped', 'disabled', 'todo']) {
      expect(xml).toContain(`<skipped message="${status}"/>`);
    }
  });

  it('escapes XML, preserves supplementary characters and replaces XML-invalid characters', () => {
    const { report } = fixture(['passed']);
    report.testFiles[0].assertions![0].fullName = 'quotes "\' & < >\n\t\u0000\uD800\u{1F600}\u001b[31mred';
    const xml = serializeJestJUnitReport(report);
    expect(xml).toContain('quotes &quot;&apos; &amp; &lt; &gt;&#10;&#9;\uFFFD\uFFFD\u{1F600}red');
    expect(xml).not.toContain('\u001b');
  });

  it.each(['suite', 'snapshot', 'coverage', 'empty', 'unexplained'] as const)(
    'reports a genuine %s failure instead of manufacturing a passing testcase',
    (failure) => {
      const { report } = fixture([]);
      report.success = false;
      if (failure === 'suite') report.testFiles[0].executionError = 'Cannot load the suite';
      if (failure === 'snapshot') report.snapshotFailure = true;
      if (failure === 'coverage') report.coverage.messages = ['Coverage threshold was not met'];
      if (failure === 'empty') {
        report.testFiles = [];
        report.passWithNoTests = false;
      }
      if (failure === 'unexplained') report.shards[0].failureReasons = ['jest-unsuccessful'];
      const xml = serializeJestJUnitReport(report);
      expect(xml).toContain('tests="1"');
      expect(xml).toContain(failure === 'suite' ? 'errors="1"' : 'failures="1"');
      expect(xml).toContain(failure === 'suite' ? '<error ' : '<failure ');
    }
  );

  it('does not fabricate tests for an allowed empty selection', () => {
    const { report } = fixture([]);
    report.testFiles = [];
    expect(serializeJestJUnitReport(report)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<testsuites tests="0" failures="0" errors="0" skipped="0">\n\n</testsuites>\n'
    );
  });

  it('keeps legacy payloads readable but explicitly refuses JUnit without assertion details', () => {
    const { payload, report } = fixture(['passed']);
    payload.version = 2;
    delete payload.testFiles[0].assertions;
    expect(validateJestShardPayload(payload)).toBe(payload);
    expect(() => serializeJestJUnitReport(report)).toThrow(/Rerun legacy cached shards/);
  });

  it.each([NaN, Infinity, -1])('rejects invalid assertion duration %s', (durationMs) => {
    const { payload } = fixture(['passed']);
    payload.testFiles[0].assertions![0].durationMs = durationMs;
    expect(() => validateJestShardPayload(payload)).toThrow();
  });

  it('rejects missing or inconsistent version 3 assertion details', () => {
    const { payload } = fixture(['passed']);
    payload.testFiles[0].assertions = [];
    expect(() => validateJestShardPayload(payload)).toThrow(/Inconsistent Jest assertion/);
    delete payload.testFiles[0].assertions;
    expect(() => validateJestShardPayload(payload)).toThrow(/Missing version 3/);
  });

  it('captures real Jest assertion names, nesting and duration in version 3', () => {
    const results = makeEmptyAggregatedTestResult();
    const suite = createEmptyTestResult();
    suite.testFilePath = path.join(__dirname, 'example.test.js');
    suite.numPassingTests = 1;
    suite.testResults = [
      {
        ancestorTitles: ['group'],
        title: 'passes',
        fullName: 'group passes',
        status: 'passed',
        duration: 1250,
        failureDetails: [],
        failureMessages: [],
        numPassingAsserts: 1
      }
    ];
    results.testResults = [suite];
    results.success = true;
    results.numPassedTests =
      results.numTotalTests =
      results.numTotalTestSuites =
      results.numPassedTestSuites =
        1;
    const payload = createJestShardPayload(results, __dirname);
    expect(payload.version).toBe(3);
    expect(payload.testFiles[0].assertions).toEqual([
      {
        ancestorTitles: ['group'],
        title: 'passes',
        fullName: 'group passes',
        status: 'passed',
        durationMs: 1250,
        failureMessages: []
      }
    ]);
  });
});
