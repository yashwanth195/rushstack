# Test Sharding in Heft

> **Scope:** Native Rush operation sharding for Heft workloads, with Jest as the first managed adapter
>
> **Compatibility:** Requires coordinated Rush, Heft, shard protocol, Jest adapter and Rush identity plugin releases

## Implementation status

This document includes both implemented behavior and proposed contracts. The current implementation supports
standalone Jest shard selection and managed Rush-native execution, claim-fenced publication, result/coverage
collation, opt-in collator-owned JUnit and same-input archive reuse. It does not yet implement independent
canonical test discovery and assignment artifacts, the scratch environment routing below, or bounded sidecar payloads.
Those are design proposals, not capabilities consumers can enable today.

BuildXL owns scheduling, input tracking and cache selection when it executes the exported Rush graph.
`shrinkwrap-deps.json` supplies package-dependency metadata; it is not the executable operation graph.
Graph execution contract version 1 now exports configured initial commands, explicit non-secret environment
overrides (including `RUSH_SHARD_GENERATION`), per-operation output folders, cache exclusions and warning policy.
Rush prepares this plan after every graph-created hook without scheduling operations or running local
environment/cache hooks. The consumer must execute individual nodes, preserve dependencies, apply the exported
overrides, track the declared outputs, honor cache exclusions and defer managed diagnostic verdicts to the collator.
This generic contract does not automatically update an existing BuildXL resolver or QTest wrapper.
Managed BuildXL execution is not yet a supported or validated integration.

The current shared generation intentionally invalidates all siblings after relevant input changes. Replacing
one attempt under unchanged inputs is supported; automatic failed-shard retry and per-test impact analysis are
not implemented. Consumers should not weaken generation checks to reuse stale results.

## 1. Goals and Non-Goals

### 1.1 Goals

**Use Rush's existing operation sharding.** Heft should supply the workload protocol rather than replace
Rush's graph, scheduler, cache or project-selection behavior.

**Preserve unsharded meaning.** For supported configurations, a sharded run must select the same tests and
produce the same logical verdict as an unsharded run. Sharding changes execution placement, not test semantics.

**Produce one coherent result.** Test results, coverage, machine-readable reports and the final exit code must
describe the complete selected test set.

**Remain correct under partial cache restoration.** Any subset of shards may be restored while the remainder
execute. The collator must treat restored and newly executed manifests identically after validating generation,
count and payload coherence.

**Fail closed.** Missing or unverifiable work must never become an empty successful result.

**Separate the neutral protocol from workload adapters.** Heft core owns identity, manifests, atomic publication,
coherence validation and collation orchestration as shared runtime capabilities. Workload plugins provide
selection, payload validation and merge behavior; future diagnostic workloads such as lint can reuse the core
protocol without depending on Jest.

**Protect cache admission.** An executed shard that persistently changes a tracked or declared input must fail
before its outputs enter the cache.

### 1.2 Non-goals

**No distributed-execution protocol.** Distribution across machines remains a Rush cobuild concern. This
design defines the shard artifacts and identity required for such execution but does not define transport.

**No sharded type checking.** Whole-program type analysis is not partition-equivalent. Splitting a type check
can hide cross-file diagnostics and is therefore incorrect.

**No managed watch mode.** A managed shard is a one-shot operation. Rush may schedule another graph iteration,
but a shard does not remain in Jest watch mode.

**No snapshot updates.** Snapshot updates mutate source-tree inputs and race across shards.

**No arbitrary reporter execution.** Managed shards do not run reporter plugins that can write shared paths or
alter results independently. Supported final report formats are emitted by the collator.

**No portable filesystem sandbox.** The design routes cooperative writes and validates persistent input
mutation. Preventing every absolute write or native syscall requires platform-specific sandboxing.

**No mandatory adoption.** Sharding is opt-in per operation. Existing unsharded projects retain their current
behavior.

---

## 2. Background

### 2.1 Native Rush sharding

Rush sharding is workload-neutral. For an operation with a configured shard count, Rush creates:

1. A no-op pre-shard join node with the original dependency set.
2. N shard operations, each depending only on the pre-shard node.
3. The original operation repurposed as a collator that depends on every shard.
4. The original downstream consumers depending on the collator.

The native contract provides:

- A shard script named `{phaseName}:shard`.
- A 1-based `--shard={shardIndex}/{shardCount}` argument.
- A shard output argument whose template ends in `{shardIndex}`.
- Automatic declaration of each shard output folder.
- `--shard-parent-folder` and `--shard-count` arguments for the collator.

Rush and Jest both use 1-based shard indices, so no index conversion is required.

### 2.2 Why ordinary Heft test execution cannot simply run N times

An ordinary Heft/Jest test phase assumes one process owns the project:

- Task temp paths do not contain a shard dimension.
- Jest caches inherit the shared task temp path.
- `--clean` can delete state used by another process.
- Reporters and coverage writers commonly use fixed project-relative destinations.
- A failed Rush operation does not unblock consumers, so a failing shard would prevent collation.
- Jest partitions tests but provides no native result or coverage merge.

The design must remove these assumptions rather than serialize around them.

### 2.3 Diagnostic versus artifact workloads

Rush's default failure propagation is correct for artifact producers: if compilation or bundling fails, the
output is unusable and consumers must not run.

Diagnostic workloads are different. Test and lint failures are the payload that an aggregator must receive.
A complete shard with recorded diagnostic failures therefore publishes a valid result and defers the verdict.
Infrastructure failure still blocks consumers because the result is incomplete or unknowable.

### 2.4 Prior art

| Tool | Partitioning | Native result merge | Native coverage merge |
| --- | --- | --- | --- |
| Bazel | Runner-defined shard environment | Aggregates test actions | Yes |
| Jest | `--shard=k/n`, by test file | No | No |
| Playwright | `--shard=k/n` | `merge-reports` | Reporter-dependent |
| Vitest | `--shard=k/n` | `--merge-reports` | Yes |
| CircleCI | File or historical timing split | Platform aggregation | No |

Bazel's required shard-status marker is the closest precedent for the mandatory manifest. A shard that appears
successful without proving completion must fail, because otherwise missing work can produce a false-green build.

---

## 3. Architecture Overview

Rush owns the operation graph, scheduling, selection and archive cache. The Rush identity plugin adds group
identity, managed cache policies and cache-admission checks. Each Heft shard process receives its partition
identity and output root, executes through Heft core's neutral shard runtime and publishes a manifest. The
collator receives the shard parent and expected count, validates the manifests through the same Heft runtime and
delegates payload merging to the Jest adapter.

### 3.1 Components

**Rush native sharding** constructs the fan-out/fan-in graph and owns operation scheduling and archive cache.

**`@rushstack/rush-heft-shard-plugin`** validates the native topology, derives the current generation, injects
managed environment values, disables collator caching and performs post-execution cache-admission checks.

**`@rushstack/heft-jest-plugin`** owns Jest partitioning, managed worker execution, result normalization,
coverage capture, Jest payload validation, result merging and report generation.

**Heft core** owns the workload-neutral shard runtime: parameter restrictions, manifest schema, output claims,
attempt fencing, atomic publication, result loading, coherence validation and adapter lifecycle. Plugins consume
this runtime through `IHeftTaskSession.registerShardCollator(adapter)` rather than by depending on another
plugin package. The registering task declares the collation parameters; Heft installs the neutral run hook on
that same task and rejects duplicate adapter registration. There is no separate neutral plugin or accessor
handshake.

**Rush core** provides lossless environment input hashing, output/input overlap rejection, fresh input snapshots
for cache-admission validation and hook ordering before archive publication.

Heft core's shard runtime and the Rush identity plugin do not depend on Jest semantics. A future workload adapter
can reuse identity, publication, complete-evidence and collator-verdict contracts while supplying its own
partitioning, payload and merge logic. Diagnostic adapters such as lint may defer their verdict; artifact
producers retain ordinary nonzero shard failure semantics.

#### Merge ownership

Keep result and coverage merging in `@rushstack/heft-jest-plugin` for this implementation. A separate merge
plugin is a reasonable future boundary: Istanbul coverage maps, V8 coverage and normalized test results are
not inherently Jest-specific. However, the current adapter also validates Jest completion evidence, snapshots,
coverage providers, source inventories, coverage exclusions and thresholds, and produces Jest's final verdict.
Splitting only the format merge today would still require a Jest configuration/semantics adapter and a new
versioned interface between the two.

The current merger uses the existing Istanbul/V8 reporting dependencies. `monocart-coverage-reports` was an
example of a collation library, not a required new dependency. Revisit extraction when a second real adapter
can share a stable, runner-neutral result and coverage contract. Heft core remains free of all these libraries
and of Jest-specific reporting rules.

### 3.2 Trust boundary

The manifest is the boundary between shard execution and collation. The collator consumes only data inside
Rush-owned shard output folders. A cache hit restores the same manifest and payload that execution produced.

The protocol validates accidental corruption and incompatible results. It is not a security boundary against a
malicious cache, dishonest custom sequencer or deliberately falsified adapter.

---

## 4. Execution Model

### 4.1 Heft phases

| Phase | Frequency | Responsibility |
| --- | --- | --- |
| `test-prepare` | Once | Clean shared pre-test state and publish immutable discovery/partition inputs |
| `test-shard` | N times | Execute partition `k/N` and publish one manifest |
| `test-collate` | Once | Validate, merge, report and emit the final verdict |

`test-shard` depends on `test-prepare`. Rush supplies the shard fan-out and collator fan-in. The command-line
phase graph must also schedule `test-prepare` before the original test operation because Heft's `--only` does
not expand phase dependencies.

`test-prepare` is noncacheable and runs for every managed iteration, including one in which every shard is
restored from cache. It publishes the current canonical inventory and partition plan into its own declared
output folder. The pre-shard join depends on this operation, so shards and the collator cannot observe a plan
from an unrelated iteration.

### 4.2 Invocation modes

**Unsharded mode**

- No shard arguments.
- Existing Jest/Heft behavior and exit semantics remain unchanged.

**Standalone partition mode**

- `--shard=k/n` without a managed output directory.
- Jest partitions and uses shard-local cache/temp state.
- Test failures retain ordinary nonzero exits.
- No generation or manifest is required.

**Managed Rush shard mode**

- Both `--shard=k/n` and `--shard-output-directory=.../k`.
- Requires a nonempty `RUSH_SHARD_GENERATION`.
- Complete diagnostic failures are deferred to the collator.
- Infrastructure failures remain nonzero.

**Collator mode**

- Receives `--shard-parent-folder` and `--shard-count`.
- Requires the current `RUSH_SHARD_GENERATION`.
- Never restores its own result from cache.

### 4.3 Owned directory layout

Exact folder names are configurable, but ownership follows this structure:

```text
<project>/
  temp/
    heft/<task>/
      shard-1-of-N/
        jest-cache/          # disposable, shard-private
        scratch/             # disposable, shard-private
    test-sharding/
      prepare/
        test-inventory.json  # current noncacheable discovery plan
        partition-plan.json
      shards/
        1/
          shard-manifest.json
          payload/
          coverage/
        ...
        N/
      collated/
        jest-collated.json
        junit.xml
        coverage/
```

Preparation, every shard and the collator own disjoint directories. Rush archives only declared durable shard
outputs. Scratch and Jest cache folders are disposable, and the collator reads only preparation and shard
outputs. No operation may declare the entire project temp tree as its output.

---

## 5. The Shard

### 5.1 Test selection

The Jest adapter passes `--shard=k/n` to Jest unchanged. A custom test sequencer must implement Jest's `shard()`
method. Selection-affecting configuration participates in the sibling-wide generation identity.

#### 5.1.1 Canonical inventory and completeness

Sharding must prove that it executed the same post-filter test-file inventory that an equivalent unsharded run
would select. Counting completed files is insufficient because a partitioning defect could omit a file while
still producing internally consistent shard results.

Preparation resolves the canonical normalized test-file inventory using the same Jest configuration, path
filters and sequencer contract as the managed run. It publishes the ordered inventory, its digest and the
expected assignment for every shard as immutable adapter data. Each shard records both its assigned identities
and the identities for which Jest produced completion evidence.

The inventory and partition plan are deterministic, human-readable JSON artifacts. CI uploads them with the
collated reports so a reviewer can inspect exactly which file belonged to each shard. During rollout, a parity
job also captures the equivalent unsharded Jest `--listTests` inventory and emits a concise added/removed/path-
normalization diff. Any inventory difference is a correctness failure, not a warning.

The collator requires:

- Every sibling to reference the same canonical inventory digest.
- Every executed identity to have been assigned to that shard.
- The assigned sets to be pairwise disjoint.
- The union of assigned identities to equal the canonical inventory exactly.
- The union of completed identities to equal the canonical inventory exactly.

Test files are the partition unit. All tests declared dynamically inside one selected file remain within that
file's shard. Discovery and assignment data are adapter payload files rather than an unbounded manifest
envelope.

Managed mode rejects configuration that cannot be merged safely or can produce uncontrolled side effects,
including:

- Arbitrary test reporters and `testResultsProcessor`.
- Jest `projects` and `preset`.
- Custom runners that bypass managed completion evidence.
- Result filters and `bail`.
- JSON output hooks that write their own final files.
- Watch mode and snapshot updates.
- Output paths outside managed roots.

Resolvers, serializers, setup files, test environments, module mapping and supported transforms remain normal
Jest configuration because they affect test semantics rather than aggregation ownership.

### 5.2 Temp, cache and test-created files

For shard `k/N`, the adapter creates a `shard-k-of-N` folder beneath the task temp folder, with separate
`jest-cache` and `scratch` children. Jest uses the shard-specific cache path.

Managed workers receive:

- `HEFT_TEST_SHARD_SCRATCH_FOLDER`: disposable shard-private scratch.
- `HEFT_TEST_SHARD_OUTPUT_FOLDER`: durable Rush-owned shard output.
- `TMP`, `TEMP` and `TMPDIR`: the same value as the scratch folder.

The adapter creates and cleans only the current shard's scratch. Scratch is not a durable result and must not
be consumed after the shard exits. Durable artifacts must be below `HEFT_TEST_SHARD_OUTPUT_FOLDER` and listed
in the manifest or adapter payload.

The process working directory remains the project folder. Changing `process.cwd()` would alter module and fixture
resolution and break existing tests. Consequently, relative writes such as `./result.json`, paths derived from
`__dirname`, absolute writes and source-tree writes are not redirected automatically.

### 5.3 Cleaning

`--clean` is prohibited on managed shard and collator invocations. Cleaning belongs to `test-prepare`, which
runs once before fan-out.

Each shard may invalidate only its own known manifest, staging files, scratch and owned outputs. It must never
recursively clean the shard parent or a sibling folder.

### 5.4 Output ownership

Managed execution acquires an exclusive claim before invalidating or publishing output. Heft stores claims in
`<buildRoot>/.heft-jest-shard-locks`, outside cached outputs. The legacy directory name is retained so older
and newer runtimes contend on the same physical claims rather than independently acquiring an output.
Claims remain held through the final cancellation check,
all in-flight operations, and cancellation cleanup.

The claim state machine is:

| State | Transition and behavior |
| --- | --- |
| `free` | Canonicalize destinations and enter registration. |
| `acquiring` | Exclusively create `acquire.lock`, check all destination overlaps, then create the complete claim set. |
| `contended` (registration gate) | Retry with randomized 5-20 ms delays, with a two-second retry deadline. Success returns to `acquiring`; exhaustion throws with holder details, retry count and deadline. This is a retry budget, not a hard filesystem-I/O timeout. |
| `contended` (output destination) | Fail immediately with `retryCount=0` and holder details. Do not retry for the lifetime of a long-running task or disturb its output. |
| `held` | The attempt may stage files. The registration gate is already released, so disjoint operations run concurrently. |
| `publishing` | Recheck the live claim and synchronously rename the fully written, flushed and closed staging file. No await separates the check and rename; releasing the claim while publishing is rejected. Return to `held`. |
| `revoked` | Cancellation revokes publication capability immediately. Retain the physical claim while work settles and cleanup completes. Neither a new publication nor a replacement owner is admitted. |
| `released` | Close and remove the verified claim only after work and cleanup settle. Old in-memory capabilities remain unusable. |
| `abandoned` (operator diagnosis) | Fatal termination can leave the claim or registration gate on disk. This is not inferred automatically from age or PID. Verify termination before targeted cleanup and return to `free`. |

`held` and `publishing` are live runtime states; claim metadata identifies the holder, not a distributed lease or
a remotely revocable lock. There is no automatic transition from an old-looking claim to `free`.

Ownership rules:

- Existing destinations use physical canonicalization.
- Windows short-path aliases resolve to the same identity.
- Missing leaves are compared using same-volume filesystem probes so case and Unicode behavior follows the
  actual destination filesystem.
- Claim identities use normalized portable paths.
- Ancestor/descendant overlap is rejected.
- Multi-output acquisition uses a short registration gate and is atomic.
- Registration contention uses bounded randomized retry.
- Active claims are never stolen based on a PID assumption.
- Partial acquisition and cleanup failures are surfaced rather than returning success.

A fatal process exit can leave an abandoned claim. Recovery requires confirming on the recorded host that the
owning process **and every worker/child process** have terminated and pending writes have settled. Then remove
only the exact claim named in the error, record that operator action in the CI/job log, and retry. Never delete
the whole claims directory, remove a claim while a writer is live, or treat PID reuse/elapsed time as proof of
abandonment. Heft deliberately has no automatic claim-stealing or cleanup command.

Valid claim metadata records the canonical destination, random attempt token, host, PID, process start time and
acquisition time, plus project, phase, task, generation and shard identity supplied by the workload. Collators
have a shard count but no individual shard index. Contention errors include the claim path, holder metadata,
computed claim age, retry policy and safe recovery instructions. Registration exhaustion additionally reports
its retry count and deadline; an output conflict explicitly reports immediate failure. Missing, malformed,
legacy or unreadable metadata is reported as such and still fails closed, never as proof of abandonment.
Diagnostics do not dump environment variables or credentials.

### 5.5 Input immutability and cache admission

Rush computes the cache key from a point-in-time input snapshot before execution. An operation that changes an
input could otherwise publish output under the pre-mutation key.

For each executed shard:

1. Retain the original tracked/additional-file hash map for the original phase.
2. After the Heft process exits, obtain a fresh input snapshot.
3. Compare the same input identities before the cache-write hook.
4. If a file was added, removed or changed, invalidate the completion manifest, mark infrastructure failure and
   disable cache publication.

The graph context must expose Rush's existing fresh-snapshot factory to graph plugins. The validation hook must
run before `CacheableOperationPlugin` writes the archive.

Completed assertion failures remain cacheable when inputs are unchanged because their manifest is a complete
diagnostic result. Crashes, cancellation, publication failure and input mutation are not cacheable.

This detects persistent mutation. It cannot universally detect a file that was modified and restored before the
final comparison. Such behavior violates the cacheable-operation contract. Platform-specific write tracing or
an OS sandbox may provide stricter enforcement but is not required by the portable protocol.

### 5.6 Exit semantics and completion evidence

| Situation | Shard exit | Manifest | Collator |
| --- | --- | --- | --- |
| Tests completed with no diagnostics | Zero | Completed | Runs |
| Tests completed with failures | Zero | Completed with diagnostics | Runs and fails |
| Empty partition completed | Zero | Completed with zero items | Runs; whole set is validated |
| Suite import error fully recorded | Zero | Completed with diagnostics | Runs and fails |
| OOM, crash or unexpected worker exit | Nonzero | No valid completion marker | Blocked |
| Global setup/configuration failure | Nonzero | No valid completion marker | Blocked |
| Cancellation or incomplete result | Nonzero | No valid completion marker | Blocked |
| Manifest publication failure | Nonzero | No valid completion marker | Blocked |
| Input mutation after execution | Infrastructure failure | Marker invalidated | Blocked |

Jest `runCLI` resolving is not sufficient completion evidence. The adapter verifies:

- Scheduled suites reached a settled state.
- Assertion and suite counters are internally consistent.
- Runtime and suite errors are represented.
- The run was not interrupted.
- Snapshot state is represented.
- Worker lifecycle and teardown completed.
- No expected result is missing.
- The final payload is serializable and schema-valid.

### 5.7 Manifest contract

Each managed shard writes `shard-manifest.json` with this envelope:

| Field | Meaning |
| --- | --- |
| `version` | Neutral manifest schema version |
| `shardIndex` | 1-based shard index |
| `shardCount` | Expected sibling count |
| `generation` | Current Rush-derived generation |
| `status` | `completed` or `harness-failure` |
| `workload` | Adapter identity such as `jest` |
| `startedAt` | Portable start timestamp |
| `durationMs` | Shard duration |
| `diagnosticCount` | Recorded workload diagnostics |
| `itemCount` | Executed workload items |
| `inventoryDigest` | Digest of the canonical post-filter workload inventory |
| `producerAttempt` | Non-semantic execution-attempt identity used for fencing and provenance |
| `payload` | Separately versioned adapter data |

The neutral envelope is workload-independent. The adapter payload is versioned separately.

Manifest publication:

1. Validate that the output is strictly below the build folder.
2. Validate that its basename equals the 1-based shard index.
3. Reject symlink or junction escapes.
4. Invalidate only the current shard's prior completion marker.
5. Write a unique staging file in the same folder.
6. Flush and atomically rename it to `shard-manifest.json`.
7. Treat the rename as the last in-process commit marker.

A shard that exits zero without a valid manifest is a contract failure.

### 5.8 Jest payload

The Jest payload is JSON data, not a serialized Jest `AggregatedResult`. It includes:

- Normalized build-root-relative test-file identities.
- Per-file passed, failed, skipped and todo counts.
- Assertion names and failure messages.
- Suite execution errors and snapshot failure state.
- Aggregate counters and explicit failure reasons.
- Coverage configuration and provider-specific data.
- Portable producer identity for output ownership.

Validation requires safe integer counters, normalized unique file identities, consistent totals, failure details
for every diagnostic and no duplicate test file across sibling shards.

### 5.9 Jest global lifecycle

Jest normally runs `globalSetup` and `globalTeardown` once per Jest invocation. Running N shard invocations would
therefore execute those hooks N times, which is not equivalent to one unsharded invocation and can race on
shared services or persistent state.

Managed mode rejects Jest `globalSetup` and `globalTeardown`. Once-per-suite initialization belongs in
`test-prepare`. Per-shard initialization belongs in ordinary setup files and must use shard-isolated resources.

The collator may be blocked when a shard has an infrastructure failure, so guaranteed cleanup cannot depend
only on collator execution. Preparation may create only build-local state that is safe to abandon or
lease-based external resources with expiry and an out-of-graph `finally` cleanup. A future always-run Rush
finalizer could own stronger teardown semantics; until then, projects requiring guaranteed persistent-resource
teardown remain unsharded.

Each shard is a separate Jest invocation and process tree. Test files must not depend on module-cache state,
mutable globals or execution order established by another test file. Jest assertion retries remain inside the
owning shard; a Rush-level retry is a new fenced execution attempt.

Projects that cannot separate once-per-suite and per-shard lifecycle work remain unsharded. A future explicit
per-shard global-lifecycle mode would be a new compatibility contract and would participate in group identity.

---

## 6. The Collator

The collator is the single fan-in operation after all shard operations. It does not execute tests. It proves
that the complete expected workload produced trustworthy evidence, merges workload-specific data, publishes
one canonical result and returns the only test verdict that downstream Rush operations consume.

### 6.1 Coherence validation

Before merging, the collator requires:

- Exactly `shardCount` manifests.
- Every index from 1 through N exactly once.
- Every recorded `shardCount` equal to N.
- One uniform workload and payload version.
- One uniform generation equal to the current `RUSH_SHARD_GENERATION`.
- Nonnegative safe integer counters with safe aggregate sums.
- No `harness-failure` status.
- Adapter-valid payloads.
- No duplicate normalized test-file identity.
- One canonical inventory digest and an exact assignment/completion union for that inventory.
- An explicit, validated zero-selection policy when the canonical inventory is empty.

A missing manifest is never an empty result. A uniformly stale set is invalid even if all manifests agree.

### 6.2 Adapter lifecycle

The neutral collator accepts exactly one adapter. The adapter lifecycle is:

1. `acquire`: claim all final output destinations.
2. `prepare`: validate paths and invalidate only owned prior final markers.
3. `validate`: validate every adapter payload and cross-shard identity.
4. `merge`: produce one collated model.
5. `publish`: atomically publish supported reports.
6. `verdict`: return the diagnostic count and success state.
7. `release`: release claims after final cancellation handling.

An adapter without neutral orchestration, or neutral orchestration without an adapter, is invalid.

### 6.3 Jest result merge

The Jest adapter combines:

- Test-file and assertion summaries.
- Suite errors and snapshot diagnostics.
- Shard durations and counts.
- Explicit failure reasons.
- Provider-specific coverage data.

The collated report is a dedicated versioned format, not Jest's unsharded `--json` schema. It contains the
generation, shard count, success state, aggregate counters, normalized test files, per-shard summaries, coverage
metadata and threshold messages.

Jest producers emit payload version 3 with real assertion titles, full names, nesting, status, duration and
failure messages; the consolidated JSON report is version 3. Version 2 payloads remain readable for JSON/coverage
collation. Configured JUnit publication rejects legacy test files without assertion details rather than inventing
passing testcases. Rerun those cached shards to obtain version 3 data.

### 6.4 Report publication

The collator owns final report generation. Supported emitters consume the validated collated model rather than
running arbitrary Jest reporter code in every shard.

Set `junitOutputFile`, for example `"temp/collated/JUnit.xml"`, in `jest-collator-plugin` options.
It is an optional build-root-relative XML filename, independently claimed alongside JSON and coverage outputs.
It cannot overlap shard inputs or other final destinations. Declare its folder in the Rush operation's
`outputFolderNames`; managed shards must not configure `jest-junit`. JUnit is published before the final JSON
marker, and failed/cancelled publication invalidates both while retaining ownership. Suite errors and final
snapshot, empty-selection and coverage failures are represented explicitly, using labeled diagnostic testcases
where no real assertion represents the failure.

Required report behavior:

- Versioned JSON is the canonical machine-readable result.
- Coverage formats are emitted from the merged coverage map.
- JUnit, when configured, is generated once with stable suite/test identities, durations, skipped state,
  failure messages and normalized source paths.
- Every destination is below the claimed collator output root.
- Filenames use documented canonical casing.
- All report files are staged before publication.
- The final JSON marker is promoted last.
- Publication failure removes or preserves prior data according to ownership, but cannot leave a current
  success marker.

### 6.5 Coverage

Shards collect coverage but do not enforce thresholds or publish final coverage reports. Every sibling records
one normalized coverage configuration, and all siblings must agree on provider, source selection, ignores,
thresholds and output formats.

For the V8 provider, shards retain raw function-scoped ranges, captured generated code and validated source-map
data. The collator merges raw ranges before converting them to Istanbul so an executed outer function cannot
incorrectly give coverage to an uncalled inner function.

For the Babel provider, shards serialize normalized Istanbul coverage maps and the collator merges them with
Istanbul's public coverage-map APIs.

Both providers use build-root-relative source identities and source hashes. Missing or conflicting source
content, unverifiable maps, source mutation and inconsistent raw coverage fail closed. The collator enforces
thresholds once and publishes supported formats such as JSON, LCOV, HTML and Cobertura. Custom coverage
reporters and output redirects remain unsupported.

Coverage completeness uses a canonical source inventory derived from the effective `collectCoverageFrom`,
ignore rules and adapter-supported dependency discovery. Before thresholds and reports are produced, the
collator adds zero-coverage entries for selected source files that no shard executed. Otherwise sharding could
incorrectly omit untouched files and report higher coverage than an equivalent unsharded run.

### 6.6 Verdict

The collator fails when:

- Any shard payload records diagnostics.
- Merged coverage violates configured thresholds.
- Coherence validation fails.
- Report publication fails.
- Cancellation occurs before the final commit marker.

The adapter publishes the consolidated report before Heft emits the final diagnostic error so failed test details
remain available even though downstream operations are blocked.

### 6.7 Determinism, provenance and scale

Canonical output ordering is independent of shard completion order and cache origin:

- Shards are ordered by numeric shard index.
- Test files and coverage sources are ordered by normalized identity.
- Assertions retain stable file-local order, with a deterministic name/location fallback.
- Diagnostics are ordered by normalized file, location, assertion identity and message.
- Report keys and arrays use documented canonical ordering.

Wall-clock timestamps, machine names, process identifiers, cache origin and measured durations are provenance,
not semantic result identity. They are recorded in a separate metadata section and excluded from generation,
coherence and deterministic-content comparisons. Rush operation telemetry is authoritative for whether the
current iteration executed a shard or restored it from local or remote cache; cached manifests retain the
identity of their original producer.

The manifest remains a bounded envelope and references separately validated adapter payload files. The
implementation enforces versioned limits for manifest size, per-shard payload size, diagnostic count, string
length and aggregate merge size. Oversized data fails with an infrastructure diagnostic rather than being
silently truncated. Collation reads and merges large payloads incrementally where the format permits and does
not require all raw coverage or diagnostics to be duplicated in memory.

---

## 7. Cache Coherence and Shard Identity

### 7.1 Identity inputs

Rush operation state has three relevant components:

| Component | Sibling behavior |
| --- | --- |
| Dependency state | Identical because every shard depends on the same pre-shard node |
| Local input state | Identical because siblings share the original project and phase |
| Runner configuration | Different because each shard has different `k/N` arguments |

Ignoring runner configuration would allow a uniformly stale group after a test filter, coverage option or shard
count change. The identity must include the complete sibling configuration.

### 7.2 Shared configuration digest

The shared configuration digest is a SHA-256 hash over a version marker, project name, phase name, Node version,
platform, architecture, pre-shard runner configuration, collator runner configuration and the sorted set of
shard runner configurations.

The plugin decorates the pre-shard runner's configuration hash with this digest. Every shard's dependency on the
pre-shard node therefore includes the complete group configuration in its native Rush cache key.

### 7.3 Generation

For each iteration, the generation is a SHA-256 hash over the identity version, project name, phase name, sorted
pre-shard dependency hashes, current local input hash and the shared configuration digest.

The same generation is injected into every managed shard and its collator as `RUSH_SHARD_GENERATION`.

The expected generation is derived only from current Rush inputs and configuration. It is never inferred from
manifests. Cache hits need not start a shard process; the current collator still receives the expected token.

#### 7.3.1 Attempt fencing

Generation is deterministic and intentionally remains stable across equivalent retries, so it cannot prevent a
cancelled process from publishing late into a newer retry's output folder. Each live output-claim acquisition
receives a random non-semantic attempt token. Sibling shards have distinct attempts; generation is the identity
they share. The manifest's `producerAttempt` is taken from its actual output claim, not a separate random UUID.

Before committing a live manifest, a shard must still own its exact output claim and retain its local
publication capability. The task's abort signal revokes that capability. The writer flushes/closes staging
content first, then checks the claim and performs the final rename synchronously in one event-loop turn.
Another process cannot acquire the existing claim. Revocation does **not** release the claim or authorize a
replacement to start while the old process can still mutate shared output.

Concrete retry race:

1. Shard 2 attempt A owns claim A for generation G and is staging its manifest.
2. Cancellation reaches A's Heft abort signal and revokes A's publication capability. B still cannot acquire
   that output; A's claim remains held. If cancellation happens after the rename, the final cancellation check
   invalidates only A's own promoted inode before the claim can be released.
3. A's workers and in-flight work settle. A removes only its owned staging/publication artifacts, then releases
   claim A. For fatal termination instead, an operator verifies termination of A and all workers before removing
   the exact abandoned claim. There is no safe shortcut that admits B while a live A can still write.
4. B acquires claim B for the same generation G but a different attempt token. B may now stage its manifest.
5. Any stale in-process continuation holding A's capability is rejected as revoked/released at the final fence,
   even if it omitted the abort signal. It cannot overwrite B's manifest. In the fatal-termination path, no A
   continuation survives; verified process termination, not a remote token revocation, supplies that guarantee.
6. B flushes and closes its staging file, checks claim B and promotes `shard-manifest.json` without an await
   between the check and rename. B retains ownership through the final completion/cancellation boundary.

Revocation therefore precedes replacement claim acquisition, and the ownership recheck immediately precedes
final manifest promotion. Generation may be identical for A and B; the live claim and revocable publication
capability exclude the stale writer. This guarantee assumes all participating writers use the runtime and
operators never manually remove an active claim.

Cached manifests may contain an older `producerAttempt`; this is valid because cache acceptance is based on the
semantic generation and payload validation. Attempt identity controls live publication only and is never added
to the cache key.

### 7.4 Topology validation

The Rush plugin recognizes groups through native operation metadata and graph edges. It requires:

- One no-op pre-shard node.
- N executable shard nodes.
- One executable collator.
- Every shard depending only on the pre-shard node.
- Every shard consumed only by the collator.
- Matching project, phase and shard count.

Unexpected nodes, edges or counts fail closed. Display names and log filenames are not identity inputs.

### 7.5 Cache policies

- Preparation and the collator are noncacheable.
- Shards use native archive caching.
- Managed shards may cache complete diagnostic manifests even when test failures were written to stderr.
- Infrastructure failures cannot write cache entries.
- Without archive caching, managed shards must not use legacy incremental skipping if that mechanism omits the
  shared generation or declared environment inputs.
- If the original collator operation is not selected, synthetic shard work is suppressed.
- A managed shard may not execute without its collator selected for the same iteration.

Changing the shard count, test selection, coverage configuration, runtime or sibling command configuration
changes the group identity and invalidates all siblings.

#### 7.5.1 Corrupt cache recovery

A cached manifest or payload that fails schema, digest, inventory or source validation is an infrastructure
failure, never an empty shard and never a partial success. The collator identifies the exact shard and artifact
that failed validation.

The initial implementation fails the current Rush invocation and may quarantine or remove only the identified
local cache entry. It does not delete a remote entry, silently ignore corruption or mutate the completed graph
to retry work. A controlled future recovery path may perform one uncached retry of the affected shard only if
Rush can reconstruct the full fan-in under a fresh attempt fence; repeated corruption fails permanently.

### 7.6 Declared inputs

Semantic environment variables and additional files belong on the original phase because Rush computes local
state using the associated phase name.

`RUSH_SHARD_GENERATION` is derived and must not appear in `dependsOnEnvVars`.

Rush input snapshots must:

- Preserve platform environment-name semantics.
- Distinguish absent and empty values.
- Hash dependency resolutions and additional files.
- Reject tracked or declared inputs inside operation output folders.

The Rush identity plugin follows Rush's lockstep version policy and requires its package version to exactly equal
the host's public Rush version.

### 7.7 Cache granularity

The initial design retains Rush's existing project/phase input granularity. Sibling shards share the same local
input hash and differ through runner configuration. Consequently, adding or changing one relevant test or source
file invalidates every shard, just as it invalidates the single operation in an unsharded run. The immediate
benefit is parallel execution, independent archives and partial restoration when only some otherwise-valid
archives are unavailable; it is not per-test-file cache invalidation.

A future optimization may separate the scheduling unit from the cache unit:

1. Resolve the canonical inventory.
2. Assign identities to stable logical cache buckets using consistent or rendezvous hashing.
3. Compute a digest from each bucket's declared test and source inputs.
4. Restore or execute buckets independently.
5. Schedule several buckets on the available worker shards for load balancing.

The bucket count, hashing algorithm, inventory version and timing database version become semantic identity.
This optimization requires precise test-to-source dependency inputs; it must not guess dependencies and risk
restoring results for tests affected by a changed source file.

---

## 8. New Configuration Surface

### 8.1 Rush project configuration

The original test operation declares:

| Setting | Required design |
| --- | --- |
| Operation | `_phase:test` |
| Preparation output | A dedicated folder such as `temp/test-sharding/prepare` |
| Collator output | A dedicated folder such as `temp/collated` |
| Semantic environment inputs | Declared with `dependsOnEnvVars` |
| Shard count | A positive configured count |
| Shard argument | `--shard={shardIndex}/{shardCount}` |
| Shard output argument | A path ending in `{shardIndex}`, such as `temp/shards/{shardIndex}` |

The `_phase:test:shard` operation declares its scheduling weight separately.

Rush automatically declares each shard output folder. The collator output must be a separate dedicated folder;
do not declare the entire project temp tree as one operation's output.

### 8.2 Heft phases and scripts

| Phase | Package script | Responsibility |
| --- | --- | --- |
| `test` | `test` | Existing unsharded Jest task |
| `test-prepare` | `_phase:test-prepare` | Clean owned state and publish the canonical inventory/partition plan |
| `test-shard` | `_phase:test:shard` | Depend on preparation and run `jest-plugin` for one partition |
| `test-collate` | `_phase:test` | Run the Jest collator adapter through Heft core's shard collation lifecycle |

The Jest collator uses a dedicated output directory and canonical filenames for the collated JSON, optional
JUnit and coverage reports.

`test-collate` configures one task using `@rushstack/heft-jest-plugin` / `jest-collator-plugin`. Its `apply()`
registers the adapter directly with Heft core. Do not configure a second `shard-plugin` task or an adapter-to-
neutral-task dependency; downstream tasks depend on the single collator task.

The ordinary unsharded `test` phase remains available for local debugging and snapshot maintenance.

Rush repurposes the original `_phase:test` operation as the collator, so the existing phase script becomes the
collator entry point when sharding is enabled.

### 8.3 Parameters and preflight

Shard parameters:

- `--shard=k/n`
- `--shard-output-directory=<path>`

Collator parameters:

- `--shard-parent-folder=<path>`
- `--shard-count=N`

Managed shard and collator parameters declare:

- `allowWithClean: false`
- `allowInWatchMode: false`

Heft validates these restrictions before lifecycle startup, cleaning or entering watch mode.

The Jest package is a multi-plugin package and declares `jest-plugin` as its explicit default so existing unnamed
references remain compatible.

---

## 9. CI and Safety

### 9.1 Empty and skipped work

One empty partition is valid because deterministic partitioning can assign no files to a shard.

A completely empty canonical inventory follows Jest's unsharded policy:

- If `passWithNoTests` is disabled, the collator emits the equivalent no-tests diagnostic and fails.
- If `passWithNoTests` is enabled, the collator may succeed only when canonical discovery explicitly proves that
  the post-filter inventory is empty.

An absent inventory, missing manifest or unexplained aggregate count of zero is never treated as
`passWithNoTests`. A nonempty inventory whose completed union is empty is an infrastructure failure. A run in
which selected files complete but all assertions are skipped is represented explicitly and follows the
configured Jest verdict rather than being inferred from aggregate counts.

### 9.2 External state

Ports, database schemas, browser profiles, service namespaces and storage prefixes are outside filesystem output
ownership. They require an explicit shard allocator. If the allocation affects semantics, it participates in
configuration or declared input identity.

Tests that cannot isolate external resources remain unsharded and normally noncacheable.

### 9.3 Snapshot maintenance

Snapshot updates are unsharded because they write tracked inputs. Orphaned snapshots may also require an unsharded
maintenance job because no shard owns a snapshot whose test file was deleted.

The supported maintenance workflow is the project's ordinary unsharded test command with Jest snapshot-update
arguments. Managed sharding fails preflight when snapshot update mode is requested; it does not silently drop
the flag or choose one shard as a writer.

### 9.4 Remote-cache data handling

Shard payloads can contain test names, stack traces, source paths, failure messages and source-map content.
Remote cache publication therefore uses the same access classification and retention policy as CI test logs,
not merely the policy for compiled artifacts.

Before publication, adapters normalize workspace paths, avoid serializing environment dumps and apply the
repository's diagnostic redaction rules. Secrets must not be added to a manifest or payload to make a test
reproducible; they remain declared environment inputs and are represented only by their input hash.

Projects whose diagnostics or coverage sources cannot be stored in the configured remote cache disable remote
cache writes for the managed test operation while retaining local execution. Cache encryption, access control,
retention and deletion remain provider responsibilities. The manifest validation protocol detects corruption
and incompatibility but does not authenticate a malicious cache provider.

---

## 10. Scheduling and Resource Use

Sharding multiplies process count. If N Rush shards each create M Jest workers, the system may run N x M workers
plus coordinators.

Managed mode defaults Jest to one worker and lets Rush own outer parallelism. A project may opt into a different
inner-worker count only with a documented resource budget.

The Rush shard operation weight must reflect expected CPU and memory consumption. Runtime tuning should consider:

- Shard count.
- Inner worker count.
- Peak RSS.
- Transform and environment startup cost.
- Coverage overhead.
- Slowest-shard duration.

Jest's default sequencer partitions deterministically by file identity rather than duration, so wall-clock time
is bounded by the slowest shard. Correctness does not depend on balanced partitions, but achievable speedup
does. A future timing-aware sequencer may use historical durations and greedy longest-processing-time
assignment; the timing database version then participates in selection identity.

---

## 11. Compatibility, Migration and Rollback

The feature is opt-in for projects, but it introduces coordinated package and behavior requirements. Rush, Heft,
the workload adapter and the Rush identity plugin must agree on the operation graph and manifest protocol. The
Rush identity plugin follows Rush's lockstep version policy and requires exact host-version equality.

The core-runtime migration removes `@rushstack/heft-shard-plugin` from dependencies and configuration. Deploy
Heft and its Jest plugin together from compatible builds; the Jest plugin's `workspace:^` peer range follows
the Heft release version. Drain old operations before upgrading. Existing claim files are never migrated or
stolen in place; incompatible claim metadata fails closed and requires verified owner termination before cleanup.

### 11.1 Existing unsharded projects

Projects that do not configure sharding retain ordinary test execution, reporter behavior, cleaning and failure
exit semantics. Compatible Heft/plugin versions must still understand the new plugin metadata.

### 11.2 Managed projects

Visible behavior changes:

- `_phase:test` becomes the collator entry point.
- `_phase:test:shard` executes the partition.
- Cleaning moves to `test-prepare`.
- A shard can exit zero while containing recorded test failures.
- The collator exit code is the authoritative verdict.
- Custom reporters and snapshot updates are rejected.
- Test-created files must use managed scratch/output roots.
- Persistent input mutation becomes infrastructure failure.

The managed compatibility boundary is defined where the behavior is enforced: test selection in section 5.1,
global lifecycle in section 5.9, coverage in section 6.5, invocation restrictions in section 8.3 and external
state in section 9. Projects requiring unsupported behavior retain the unsharded path.

### 11.3 Migration safety

Adoption is allowlist-based. Before enabling cache writes, compare:

- Unsharded execution.
- Managed `N=1`.
- Managed `N=2` and the intended production count.

Parity covers selected test identities, counters, failure details, reports, coverage and exit status.

Cache validation covers cold execution, full restoration, partial restoration, generation changes, shard-count
changes, missing/corrupt manifests, cancellation and worker failure.

Remote cache writes should be enabled only after local parity and cache-admission checks pass.

Rollout gates are measured per allowlisted project against an unsharded baseline:

| Gate | Required action |
| --- | --- |
| Selected-test, result, coverage or exit-status mismatch | Disable sharding immediately; zero tolerance |
| Missing, duplicate, corrupt or incoherent evidence | Disable sharding immediately; zero tolerance |
| Infrastructure-failure rate | Must not exceed the agreed pilot baseline; automatic fallback when exceeded |
| Remote-cache restore validity | Must meet the pilot-derived target before remote writes are enabled |
| Slowest-shard wall time | Must improve or remain within the approved regression budget |

The pilot records baseline values before choosing numerical thresholds for environment-dependent reliability,
cache and performance gates. Correctness thresholds are always zero tolerance. CI reports the evaluated gate,
observed value and fallback decision so rollback is automatic and auditable rather than subjective.

### 11.4 Rollback

Rollback is atomic at the operation configuration level:

1. Restore `_phase:test` to the original unsharded Heft test phase.
2. Remove the operation's `sharding` block.
3. Restore original output declarations and downstream report consumers.
4. Remove unused shard/preparation scripts and edges.

Removing only the sharding block is insufficient if `_phase:test` still invokes the collator.

---

## 12. References

- [Rush phased builds](https://rushjs.io/pages/maintainer/phased_builds/)
- [Rush build cache](https://rushjs.io/pages/maintainer/build_cache/)
- [Heft plugin architecture](https://heft.rushstack.io/pages/plugins/architecture/)
- [Jest command-line sharding](https://jestjs.io/docs/cli#--shard)
- [Jest custom test sequencers](https://jestjs.io/docs/configuration#testsequencer-string)
- [Jest coverage configuration](https://jestjs.io/docs/configuration#collectcoverage-boolean)
- [Bazel test sharding](https://bazel.build/reference/test-encyclopedia#test-sharding)
- [Playwright sharding and report merging](https://playwright.dev/docs/test-sharding)
- [Vitest test sharding](https://vitest.dev/guide/improving-performance.html#test-sharding)
- [CircleCI test splitting](https://circleci.com/docs/guides/optimize/parallelism-faster-jobs/)
