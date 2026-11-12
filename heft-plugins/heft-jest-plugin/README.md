# @rushstack/heft-jest-plugin

This is a Heft plugin for running Jest.

Set `passWithNoTests: false` in the Jest task's `taskPlugin.options` to fail an empty test selection
(the default is `true`). Managed partitions may be empty; the collator enforces this policy across
the complete selection.

For one consolidated JUnit report, set `junitOutputFile: "temp/collated/JUnit.xml"` in
`jest-collator-plugin` options. The path is build-root-relative and opt-in; declare its folder among the
collator operation's outputs. Remove `jest-junit` from managed shard reporters. Version 3 payloads preserve
real assertion names, outcomes, durations and failures; legacy version 2 payloads remain readable for JSON
collation but cannot supply missing JUnit test details. Suite, snapshot, empty-selection and coverage failures
remain failures in the XML. Aggregate-only failures use explicitly labeled diagnostic testcases.

## Managed collation ownership

The Jest collator keeps its fixed report paths (`temp/jest-collated.json` and the adjacent
`jest-collated-coverage` folder and inventory by default). It exclusively claims the final JSON,
optional JUnit file, coverage directory and inventory before preparation, retaining ownership through validation,
publication and the outer Heft task's final cancellation cleanup. Overlapping options, filesystem
aliases and nested destinations cannot acquire concurrent ownership; disjoint destinations can.

Claims use the same canonical-destination helper as managed shard execution and live under
`<buildRoot>/.heft-jest-shard-locks`, outside normal preparation outputs and cached shard artifacts.
A short-lived `acquire.lock` serializes claim registration, not collator execution. Never clean active
claims or cache this directory. A terminated operation can leave an output claim or registration
gate: remove it manually only after confirming **all processes of the owning operation have exited**.
There is no automatic PID-based or age-based reclamation.

Configure only `jest-collator-plugin`; it registers with Heft core through
`IHeftTaskSession.registerShardCollator()`. No separate neutral plugin is needed. Jest retains result and
coverage merging because completion, snapshots, thresholds and the final verdict still require Jest semantics.
Cancellation revokes publication immediately but retains claims until work and cleanup settle. Contention
errors identify the holder and safe recovery steps; only registration-gate contention is retried.

`JestCollationAdapter.acquireAsync(context)` returns an explicitly owned session. Use its
`prepareAsync()`, `collateAsync(result)` and synchronous `release()` for multi-stage integrations;
release in `finally` only after all operations and cancellation cleanup have settled. The adapter's
direct `prepareAsync(context)` and `collateAsync(result, context)` methods remain self-contained:
each acquires and releases its own session. Separate direct calls do not reserve the gap between them.
Coverage deletion still requires the content-bound inventory and a complete, validated current shard
set; uncertain coverage files are preserved even when the final JSON and configured JUnit are invalidated.

## Links

- [CHANGELOG.md](
  https://github.com/microsoft/rushstack/blob/main/heft-plugins/heft-jest-plugin/CHANGELOG.md) - Find
  out what's new in the latest version
- [@rushstack/heft](https://www.npmjs.com/package/@rushstack/heft) - Heft is a config-driven toolchain that invokes popular tools such as TypeScript, ESLint, Jest, Webpack, and API Extractor.

Heft is part of the [Rush Stack](https://rushstack.io/) family of projects.
