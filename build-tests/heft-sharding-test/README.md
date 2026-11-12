# Real Rush/Heft/Jest sharding integration

This private build-test project runs the built workspace Rush engine, Heft's core shard runtime,
Jest execution/collation adapters and the Rush-versioned identity plugin. All are declared
workspace development dependencies so Rush builds them first. Nothing is mocked in the shell or archive
path. The outer repository retains its Rush 5.178.1 bootstrap pin.

## Run

From the RushStack root:

```powershell
node common\scripts\install-run-rush.js update --to heft-sharding-test --bypass-policy
node common\scripts\install-run-rush.js build --to heft-sharding-test --parallelism 2
Set-Location build-tests\heft-sharding-test
node ..\..\common\scripts\install-run-rushx.js _phase:test
```

The ordinary `rush test --to heft-sharding-test` pipeline also schedules this project's `_phase:test`.
The dedicated command above avoids rerunning dependency test suites when investigating this fixture.
Use one outer Jest worker: nested Rush owns parallelism 2, and managed Jest owns one worker per shard.
The integration Jest budget is ten minutes per test and the child hard timeout is eight minutes.
A timed-out or signalled child rejects the test; it is never counted as an expected nonzero verdict.

## Files and side effects

`src/test/RushHeftFixture.ts` constructs `temp/rush fixture` (intentionally containing a space) using
only declared dependency package locators. It creates a nested Git **index**, with `git init` and
`git add`, plus one empty initialization commit. Rush's native Git detection requires a HEAD SHA;
`git init` plus `git add` alone was verified insufficient. No fixture source is committed, and
the enclosing RushStack checkout is never staged or committed.

It runs normal `update-autoinstaller` and `update` using `libraries/rush-lib/lib-commonjs/start.js`,
not a private launcher or the version selector. The autoinstaller installs a freshly packed archive of the
Rush-versioned identity and graph-export packages rather than workspace links.
Its installation, manifest metadata, locks and options use real Rush
machinery. Heft package junctions resolve already-built workspace plugins. No extra tools are installed;
Rush may initialize its configured PNPM installation if not already present.

The generated graph is `_phase:test-prepare` → native `_phase:test` shards → collator → `_phase:consume`.
Preparation runs once with `--clean` over only shard, report, Jest-cache and downstream folders. Preparation
caching is disabled in settings; the identity plugin sets only the collator's public `runner.cacheable`
to false. Disabling the original phase's cache setting would disable **all** shards in Rush 5.179.0.
Native shard output caching remains enabled. The collator's
dedicated `temp/collated` inventory is copied by a real downstream Heft task only on success.
The nested repository enables `buildCacheWithAllowWarningsInSuccessfulBuild`; the identity plugin marks
only managed shard runners as allowing stderr diagnostics on zero exits. This exercises cached failing
manifests without making the collator or ordinary projects warning-tolerant.
An ordinary nonsharded Jest project runs in the same command and asserts that it receives no identity.
Preparation selects exact output-root globs, rather than implicitly selecting every nested directory.
This avoids concurrently recursively deleting both ancestor and descendant folders in Heft's cleaner
(which can produce Windows `EPERM`), while still deleting the entire selected output trees.

`configureMatrixAsync({ projects, phases })` opts into multiple managed projects and phases; the default
fixture remains one managed app plus the ordinary project. The acceptance matrix uses two managed projects
with `unit` and `verify` phases simultaneously. Every group has its own shard, report, coverage, downstream,
Jest-cache and instrumentation paths. Added project manifests receive dependency snapshots through normal
Rush `update`; no installation flags or hash files are fabricated. Reset/teardown restores the original
repository configuration and removes only the added fixture projects after all children exit.

`fixtures/fixture-task.cjs` records preparation/collator child identities. For fault tests only, its
ordered pre-collation task damages an actual completed/restored manifest. It cannot supply a verdict,
replace a runner or simulate cache success. `observe.cjs` records real suite starts independently of
cached outputs. Cache tests remove only this generated repository's native archives/output directories.

Generated files/logs remain under the ignored project `temp` folder for diagnosis, and the next suite
initialization replaces only `temp/rush fixture`. Numbered `logs/*.log`, project `rush-logs`, manifests,
merged JSON and coverage reports retain real process evidence. Do not run two copies of this fixture
concurrently in the same project checkout.

For a previously initialized fixture, `HEFT_SHARD_TEST_REUSE_FIXTURE=1` skips the initial installation and
empty commit. It verifies current workspace packages and both packed Rush plugins, and refreshes
the generated preparation clean selection. Matrix-added projects still require their normal Rush update.
An autoinstaller pointing to an older packed plugin is rejected rather than silently testing it.

## Contract

Tests check complete 1-based file partitioning; current child generation; final report, coverage JSON
and lcov; downstream gating; all/partial native cache hits; cached diagnostic failures; sibling-wide
source/count/selection/environment invalidation; assertion/import/timeout/snapshot diagnostics;
missing/corrupt/duplicate/extra/stale/mixed outputs; empty versus all-skipped work; V8 nested-function
80% threshold regression; exact canonical-versus-managed V8 maps and counters for shebang/CRLF modules,
including upstream negative-column metadata; Babel coverage;
unsafe settings; harness termination and retry invalidation; early clean/watch rejection. A cache-disabled
case changes a declared environment input without preparation, so unconditional preparation cannot mask
incorrect legacy skip decisions. All-suite import failures, with coverage enabled and disabled, must retain
a failing consolidated report even when no assertions execute.
A real OOM case caps the shard's Node heap at 96 MiB; a separate case
terminates a running shard with SIGTERM. Both require a marker written inside the failing test body,
so an unrelated startup failure cannot masquerade as a successful fault injection. Neither uses the
fixture watchdog as an expected test verdict.

External-contract cases consume exported commands and explicit environment overrides in dependency order,
verify native-equivalent generations and final diagnostic verdicts, and check cache/output/warning metadata.
They do not emulate or certify BuildXL/QTest. The default fixture opts into collator-owned JUnit, including
fresh publication from fully or partially restored native shard archives.

The bounded native matrix verifies:

| Scenario | Evidence |
| --- | --- |
| Four groups cold / warm | Four distinct current generations, eight archives; all eight restored manifests unchanged, no new suite executions, four fresh reports per invocation |
| Evictions in two different groups | Six native cache hits, exactly two new suite executions, unchanged generations |
| Declared per-group environment | Only that group's generation and suite executions change |
| Project and Rush phase identity, count, Jest configuration | Both phases of the changed project invalidate; the other project's manifests and generations remain unchanged |
| One diagnostic-failing group, then all-cache retry | All nine shards restore on retry after the count change; the failing report stays red while three independent reports/downstream consumers remain successful |
| Cache writes disabled | Repeated cold execution creates no archives; existing archives can still restore without Jest while the collator runs |
| Cache reads disabled | A native nonincremental command reruns every shard, retaining the same generation and writing its archives |
| Per-operation restriction | `disableBuildCacheForOperation` on the original phase prevents all sibling archive reads/writes, without suppressing fresh reports |

Rush hashes ordinary project files at project granularity. Changing a package script or project-local Jest/
Rush configuration therefore invalidates both phases of that project, even when only one phase's setting
changed. Declared environment inputs remain phase-specific. These expectations preserve native semantics,
not a promise of finer per-file dependency tracking.

Fatal termination may leave `.heft-jest-shard-locks` claims outside normal test output folders. The
fixture's reset removes only its own claim namespace after all its invocations have closed; it rejects
reset while any invocation is active. Ordinary preparation never clears active ownership.

These tests do not exhaust possible operating-system, hardware or network failures, distributed caches,
large-scale performance, or arbitrary custom sequencers' partition algorithms. Watch mode and coordinated
release/distribution certification remain outside this acceptance matrix. The host range guard does not
certify published Rush 5.179.0: native input fixes remain workspace-only until an actual released minimum
is assigned. See the
[adoption guide](../../docs/heft/test-sharding.md#16-adoption-checklist-and-reproduction) for compatibility,
configuration, supported coverage and correctness limits.
