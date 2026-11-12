# @rushstack/rush-heft-shard-plugin

Rush plugin for the
[managed Heft shard protocol](../../docs/heft/test-sharding.md#7-cache-coherence-and-shard-identity).
It binds every shard and its collator to one current input identity without replacing Rush's graph,
scheduler, or build cache.

## Compatibility and build

The production imports from `@microsoft/rush-lib` are **type-only public exports**. That workspace package is
a development dependency, not a runtime dependency or a second Rush engine. The runtime dependency
`@rushstack/rush-sdk` exposes the host's public `Rush.version`: Rush initializes the SDK with its own engine
before loading the plugin. The implementation uses the host session, graph, operations and execution records.
It does not read the requested version in `rush.json`, the SDK package's version, private module paths or
process arguments to identify the host.

This package uses Rush's lockstep version policy and must exactly match the repository's Rush engine version.
`apply()` compares the host's public `Rush.version` with this package's own version before registering hooks.
Older, newer, invalid and prerelease hosts fail with an actionable compatibility error. This exact-version
contract ensures that the plugin cannot be installed with a Rush release that lacks the native
environment/input-output fixes required by managed shard cache identity.

From the RushStack root, after dependency installation:

```powershell
node common\scripts\install-run-rush.js build --to @rushstack/rush-heft-shard-plugin
```

For targeted validation when dependencies are already built:

```powershell
Set-Location rush-plugins\rush-heft-shard-plugin
node ..\..\common\scripts\install-run-rushx.js build --max-workers=1
```

Use serial Jest workers on shared Windows hosts; allow a few minutes for TypeScript and fixture filesystem I/O.
Do not check in emitted JavaScript or a packed archive.

## Register in an adopting repository

Install the package version that exactly matches `rushVersion` in the adopting repository. No private Rush
loader or special module resolution is required. Runtime dependencies include the host-binding Rush SDK and
`semver`; the published package pins the matching Rush SDK through Rush's lockstep release policy.

`common/autoinstallers/shard-identity/package.json`:

```json
{
  "name": "shard-identity",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@rushstack/rush-heft-shard-plugin": "<same version as rushVersion>"
  }
}
```

Use Rush's `update-autoinstaller --name shard-identity`, followed by `update`, with the matching engine.
Rush copies the plugin manifest to the autoinstaller's `rush-plugins` metadata folder; retain that generated
metadata and the autoinstaller lockfile with the adopter's configuration.

`common/config/rush/rush-plugins.json`:

```json
{
  "plugins": [
    {
      "packageName": "@rushstack/rush-heft-shard-plugin",
      "pluginName": "rush-heft-shard-plugin",
      "autoinstallerName": "shard-identity"
    }
  ]
}
```

`common/config/rush-plugins/rush-heft-shard-plugin.json`:

```json
{
  "phaseNames": ["_phase:test"]
}
```

Only native sharded operations for the explicitly selected phases are managed. The project must configure
native `sharding.count` on `_phase:test`, its normal script must run the Heft collator, and its
`_phase:test:shard` script must run managed Heft/Jest shards as described in the design document. Ordinary
unsharded projects in the same phase are unaffected. This plugin does not change command-line arguments
or choose the shard index.

The RushStack acceptance fixture installs a packed copy into its generated repository's autoinstaller using
the same public manifest and options path. Do not use the internal `builtInPluginConfigurations` launcher
option.

## Identity and cache contract

1. Validate the exact pre-shard → N shards → collator topology using public configuration and graph edges.
2. When Rush hashes the current execution records, SHA-256 a canonical JSON array of the version marker,
   project/phase, actual Node version/OS/architecture, original pre-shard configuration, collator
   configuration and **sorted complete sibling configurations**. Keep each runner configuration opaque.
3. Decorate the pre-shard runner's public `getConfigHash()` with a **lazy** digest callback. Preserve the
   original pre-shard callback and read current collator/sibling callbacks on every call, so later graph
   plugins and watch-iteration configuration changes are included before native record hashing. The existing dependency
   edges now bind the common configuration into **every shard cache key**. There is no dependency on
   execution records or the generated environment variable at this stage.
4. At `configureIteration`, hash the current pre-shard record's sorted dependency components, local
   component and decorated configuration, with the format marker and project/phase.
5. Store that token in each current shard/collator record's explicit `environmentOverrides` as
   `RUSH_SHARD_GENERATION`. Native execution applies overrides after local environment hooks; graph export
   serializes the same non-secret token without evaluating those hooks. Each iteration owns distinct records.
6. Set the collator's public `runner.cacheable` capability to false. Every executing group must validate
   restored manifests against its current token and publish its verdict. With archive caching enabled,
   native shard caching is unchanged. Without it, set managed shards' `cacheable` to false during native
   `beforeExecuteIterationAsync` to bypass
   native legacy skipping: that strategy does not compare declared environment inputs or pre-shard dependency
   identity. Rush's generation-aware in-memory iteration decisions still apply.
   Do **not** set `disableBuildCacheForOperation` on the original phase: Rush 5.179.0 checks that configuration
   by associated phase for every sibling and would disable shard caching as well. The full shell/archive
   fixture exposed this distinction; a runner capability preserves sibling archive eligibility.
   External planning does not run this native-only legacy guard, so external shard caching remains eligible.
7. Set `warningsAreAllowed` only on managed shard runners. Jest's recorded failures and its legitimate
   empty-partition notice may use stderr even though the shard commits a complete manifest and exits zero.
   The collator remains the verdict owner; nonzero processes still fail, and unmanaged runners are unchanged.
8. After native `configureIteration` decisions, treat the **collator's current enabled state** as the original
   phase's selection authority. If it is disabled, disable its synthetic pre-shard/shard records too, preserving
   `--changed-projects-only`, unchanged groups and explicit phase exclusions. If the collator is enabled, retain
   native shard decisions so unchanged results can be reused. Do not mutate persistent operation selection or
   ordinary operations. A final pre-execution guard rejects enabled shards without an enabled collator if a later
   plugin breaks this invariant.

To cache completed diagnostic/empty manifests, set
`"buildCacheWithAllowWarningsInSuccessfulBuild": true` in `common/config/rush/experiments.json`.
Without it, native Rush reruns stderr-producing shards even though they exited zero. This setting permits
cache writes only for operations already allowing warnings: review other explicitly warning-tolerant
operations in an adopting repository. Do not globally allow warning exits or suppress original diagnostics.

This covers source, upstream inputs, registered environment/external files, test/coverage CLI changes,
runtime, project/phase and shard-count changes. It never reads manifests, hashes post-shard dependencies
to infer expected identity, or parses Rush's log/display naming conventions. Cold execution, partial
cache hits and all-shard cache hits have the same identity for the same inputs.

Declare `dependsOnEnvVars` and `dependsOnAdditionalFiles` on the **original phase**, even if also declared
on `:shard`: Rush's local snapshot lookup uses the associated phase, not the shard settings' operation
name. Shard-only declarations fail. Never declare the derived `RUSH_SHARD_GENERATION` as an input.
Do not ignore output-affecting CLI parameters or leave semantic environment inputs undeclared.
Environment-changing plugins must use registered inputs and must not overwrite this explicit generation
override in later configuration hooks. Configuration callbacks must be side-effect-free and stable during
an iteration's hashing; change configuration before scheduling the iteration, not in `configureIteration`,
which runs after native hashes are memoized. Plugins must not break group enablement after this plugin's
late iteration hook.

Rush validates inherited `RUSH_*` names before plugin loading and rejects `RUSH_SHARD_GENERATION` there.
Do not preseed it in the parent Rush CLI process; let this plugin supply it to child operations.

The identity format marker must change if the algorithm changes incompatibly. Neither this token nor
Rush's underlying input hashes are an authentication mechanism; retain collator manifest schema,
count, index, payload integrity and success validation.

## Test scope

Tests load the **built package through Rush's autoinstaller plugin loader**, validate real options and
manifest metadata, and build native `PhasedOperationPlugin` / `ShardedPhasedOperationPlugin` /
`ShellOperationRunnerPlugin` graphs from actual Rush/project configuration files. When archive caching is
disabled, fixtures also install native `LegacySkipPlugin`. Real `InputsSnapshot`,
`OperationGraph`, execution records and public hooks perform hashing and environment injection.
Package installation is represented by a local directory junction; there is no registry access.

Tests cover the public host-version guard (including lower/upper bounds through the real autoinstaller
entry), current sibling/collator equality, reruns/order independence, overlapping scheduled records,
source/upstream/environment/config/runtime/count/domain invalidation, lazy sibling-wide cache-key binding
after later graph hooks and across iterations, unsharded isolation, spoof overwrite, missing Git and malformed
topology. Small real shell runners exercise native multi-iteration enablement, diagnostic verdict ownership,
whole-group exclusions, and legacy-skip invalidation without replacing those native hooks. Archive-enabled unit
fixtures validate runner capabilities; actual archive I/O remains in the integration fixture. The all-cache-hit test
substitutes only shell/cache I/O at `beforeExecuteOperationAsync`, returning native `FromCache` without
requesting a shard environment. [`heft-sharding-test`](../../build-tests/heft-sharding-test/README.md) additionally
uses actual shell execution, normal autoinstaller preparation and native local archive restoration.
Its opt-in two-project/two-phase matrix also exercises isolated paths and generations, full/partial archive
restoration, project/phase renames, count/configuration/environment invalidation and a cached failing group
alongside three successful groups. Native cache-policy cases cover write-disabled, nonincremental
read-disabled and original-phase cache-disabled operation settings.
