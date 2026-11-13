# Validation

Initial verification date: **2026-10-15**.

## Automated checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run format:check
nix flake check
```

The suite covers profile validation, keeping credentials/security fields out of
routing metadata, native model preservation, pagination, duplicate IDs, direct
provider parameters, prewarming, follow-up/resume provider checks, remote-host
exclusion, global-default preservation, cross-version structural discovery, and ASAR metadata
and integrity preservation.

Version 0.3 adds display-name validation, native layer precedence, disabled and
project-layer exclusion, display metadata, and preservation of raw
inference IDs. The native-backend smoke uses a real `model_name` TOML field,
confirms native normalization drops it, and verifies the patched model list
recovers its label while the upstream still receives the unchanged model ID.

## Actual application assets

Work with a disposable archive, retaining the original application untouched:

```sh
cp --reflink=auto /path/to/original/app.asar /tmp/provider-smoke.asar
chmod u+w /tmp/provider-smoke.asar
node dist/cli.js check --asar /tmp/provider-smoke.asar
node dist/cli.js patch --asar /tmp/provider-smoke.asar
node dist/cli.js check --asar /tmp/provider-smoke.asar
node scripts/verify-upstream.mjs --asar /tmp/provider-smoke.asar
```

`verify-upstream.mjs` executes the actual patched upstream method bodies against
a test transport. It verifies model listing/filtering, retention of native access
checks, new-chat routing, prewarming, and default-model selection. This passed for
desktop 26.1007.71326. No proprietary application fixture is committed.

## Native backend and direct transport

```sh
node scripts/verify-app-server.mjs --codex /path/to/desktop/resources/codex
```

This uses an isolated temporary `CODEX_HOME` and a localhost test upstream. It
starts the real native app-server and verifies profile registration, provider
selection, authenticated direct Responses requests, accepted tool declarations,
and streamed completion. It also confirms that the global provider remains
OpenAI. The test does not use account credentials or external inference. It
passed using the backend bundled with the tested desktop fixture.

Version 0.2 also verifies that the actual patched model/effort selector preserves
all declared custom choices even when native account settings enable only high,
while native model filtering stays intact. The native backend test runs two turns
with low and max respectively (including collaboration mode), and checks the
actual upstream `reasoning.effort` values rather than just picker metadata.

## Live provider verification

A separate isolated ephemeral native-backend check successfully completed a
text inference with **OpenRouter `z-ai/glm-5.3-flash`** on 2026-10-15, using the
existing provider's native authentication helper. No credentials, returned
prompts, or account data were copied into this repository. The live check also
submitted the backend's native tool declarations; it did not ask the model to
execute tools.

## Remaining manual verification

The running desktop was not replaced or restarted during implementation. After
activating the Nix build, verify the visible menu, separate official/custom chats,
and restart/resume behavior in the actual Electron UI. Executing the patched
method bodies and backend tests is evidence about those boundaries, not a claim
that an interactive Electron session has already been checked.

## GLM effort correction

The GLM preset now declares only `low`, `high`, and `max`, following the
[official Z.ai model card](https://huggingface.co/zai-org/GLM-5.3-Flash#note).
Earlier low/medium live calls established transport acceptance only: the native
model template treats unrecognized values such as `medium` as `max`. They did
not establish a separate medium reasoning level. The current backend and
upstream-asset checks exercise the corrected preset, including explicit `max`.

## Single-profile effort lists

Version 0.4 requires one profile with `model_reasoning_efforts = ["low", "high",
"max"]` and a native scalar default such as `model_reasoning_effort = "high"`.
The native backend smoke verifies this exact TOML shape, including raw-list
recovery and actual low/max scalar request values. Unit tests reject empty,
invalid, duplicate or missing lists, defaults outside the list, and repeated model
profiles. A separate native-loader probe confirmed that assigning a list to the
singular enum key fails configuration loading; using the plural extension keeps
the native configuration valid.

## Structural discovery and CI (0.6.0)

The suite accepts unknown old/future version strings and absent version metadata.
It exercises renamed/nested assets, changed source hashes, combined modules,
split modules, idempotence, and installed-patch integrity. Missing or ambiguous
patch points, malformed candidate syntax, invalid manifests, and occupied runtime
paths must leave the original archive unchanged.

CI runs source checks and real-archive validation against `nix/upstream.json`,
then builds the tool. The app archive remains in the disposable build directory.
Main/PR CI does not upload releases or artifacts. The separate Release workflow
now packages the compiled tool and production dependencies, checks the archive's
SHA-256 checksum, and runs the extracted CLI before uploading Release assets.
It does not distribute the upstream app. The local consumer builds the GitHub
source flake; its Desktop version is pinned independently in its own derivation.

The pipeline does not launch the graphical app or make authenticated model
requests. Existing real-backend smoke evidence above remains separate from
these structural and archive checks.

## Release package validation (2026-11-13)

The compiled **0.6.0** Nix output was packaged with its production dependencies
on Linux x86_64. The tarball passed SHA-256 verification and the extracted CLI
ran both through Node and directly through its portable shebang. The CLI's
executable bit is restored during packaging. TypeScript and Prettier were absent
from the archive; the package includes examples and source revision metadata.
Repeated packaging with identical inputs produced identical archive bytes.
A mismatched tag failed before creating an output directory.

The workflow passed `actionlint`; type checking, all 55 unit tests, build, version
consistency, formatting, and `nix flake check` also passed. The latter checked the
real **26.1103.32239** Desktop fixture on a disposable archive. No installed app
was modified. This local validation did not exercise GitHub event delivery or
asset-upload permissions and did not create or change a live Release.

## Standalone package validation (0.6.1, 2026-11-13)

The Linux x64 platform archive was built with the official **Node 24.22.3**
binary after verifying its pinned distribution hash. Its extracted launcher ran
with an empty PATH from a directory containing spaces, without a separate Node,
npm, compiler, or Nix command. The test verified runtime version/architecture,
license and source metadata, CLI success/failure exit codes, synthetic native
catalog preservation and external-model generation, read-only ASAR checking,
patching, idempotence, and unrelated payload preservation through the independent
`@electron/asar` reader. Local NixOS execution used its existing `nix-ld` setup.

The same driver runs on native Linux, macOS, and Windows runners for both x64 and
ARM64 before publication. Main source checks retain the 55 unit tests and real
Desktop **26.1103.32239** validation on a disposable archive. These CLI and
synthetic-archive tests do not exercise the graphical application or certify real
macOS/Windows Desktop archives. Linux runtime packages target glibc; no musl
package is provided.

The first native preview exposed that Windows `Compress-Archive` rejects the
generic tarball's 1970 timestamps. Windows staging now normalizes file/directory
timestamps to 2000 before ZIP creation; runtime bytes and licenses stay unchanged.
The next Windows preview reached execution and exposed the ASAR reader's use of
host path separators. Canonical archive paths now convert at the reader boundary,
including independent verification before atomic replacement. Catalog output
continues to flush its temporary file and rename in the same directory; POSIX
also fsyncs the directory, while Windows skips that unsupported operation. Native
tests include replacing an existing catalog and preserving it after a failure.

## Context-window probe (2026-11-08)

An isolated probe used the backend bundled with Linux Desktop **26.1021.22027**
(`codex-cli 0.164.0-alpha.11.1`), temporary configuration, and the localhost
Responses fixture from `scripts/verify-app-server.mjs`. No user configuration,
credentials, installed archive, or existing chat was modified.

Before the catalog migration, the README's profile-level
`model_context_window = 1048576` did **not** reach
the thread override on this backend:

- Native `config/read` retains the field in the raw user layer but removes it
  from the normalized profile, warning that the profile key is ignored.
- `readProfiles` copies model tuning only from normalized profiles. Its raw-layer
  fallback recovers only `model_name` and `model_reasoning_efforts`.
- Consequently, `thread/start.config` contains the reasoning effort but no
  context-window override. Profile-level `model_auto_compact_token_limit` is
  dropped in the same way.

The existing unit tests supply these fields directly in synthetic normalized
profiles, so their passing forwarding assertions do not establish native config
loader compatibility. All 41 unit tests passed during this investigation.

Two-turn localhost comparisons using `z-ai/glm-5.3-flash` returned
`thread/tokenUsage/updated.tokenUsage.modelContextWindow = 258400` in every case:

| Configuration route                     | Requested context window | Reported window |
| --------------------------------------- | ------------------------ | --------------- |
| README profile, current patch           | 1048576                  | 258400          |
| Explicit `thread/start.config` override | 1048576                  | 258400          |
| Top-level temporary `config.toml`       | 1048576                  | 258400          |

For the top-level case, `config/read` confirmed the configured values
`model_context_window = 1048576` and `model_auto_compact_token_limit = 900000`.
Omitting model selection from follow-up turns did not change the reported window
in either the explicit thread override or top-level case. The context-window
field was absent from the fixture's Responses request bodies.

These observations establish a profile-loading gap and an additional native
backend/reporting limitation for this tested route. Recovering raw profile fields
alone is not sufficient evidence of a fix. The probe did not fill the context
window, trigger automatic compaction, or verify the graphical usage display;
it does not establish whether all internal token-budget decisions ignore the
top-level overrides, nor does it establish behavior on other backend versions.

### Follow-up: native fallback ceiling

Further isolated probes on the same Desktop backend passed smaller windows
directly through `thread/start.config`:

| Requested context window | Reported window |
| ------------------------ | --------------- |
| 65536                    | 62259           |
| 131072                   | 124518          |
| 262144                   | 249036          |
| 300000                   | 258400          |
| 1048576                  | 258400          |

This narrows the earlier limitation: the native override is consumed, but large
values hit a ceiling. The inspected upstream
[`model_info.rs`](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/model_info.rs)
sets both `context_window` and `max_context_window` to 272000 for unknown model
slugs. `with_config_overrides` clamps the configured window to that maximum.
The protocol's
[`ModelInfo`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)
calculates usable context using `effective_context_window_percent` (95 for the
fallback). These formulas match every observed result above. The source inspected
was upstream main on 2026-11-08, not a claim of exact source identity with the
bundled binary.

A complete fix needs two distinct changes:

1. Recover only the two missing budget fields from enabled, non-project raw
   profile layers, with native precedence and positive safe-integer validation.
   Preserve explicit request overrides and the existing thread provider guards.
2. Supply accurate native model metadata, or change the native fallback handling
   specifically for explicitly configured third-party threads. Keep known OpenAI
   model metadata, entitlement checks, and provider authentication intact. This
   is beyond the current renderer-only patch; recovering profile fields alone
   cannot make a 1048576-token window usable on this tested backend.

The official config schema describes `model_catalog_json` as startup-only;
per-thread overrides do not reload it. Replacing the shared native catalog is not
a drop-in fix for this project's mixed native/custom model menu. Validation of
any complete fix must cover native window reports and actual compaction behavior,
not only forwarded request fields or displayed UI values.

## Native catalog migration (2026-11-08)

The runtime now uses startup `model_catalog_json` as the model metadata source.
It decorates existing native catalog entries and uses profiles only for explicit
provider routing. Legacy profile model settings produce a migration error.
This deliberately replaces the previous renderer-only registration design with
a static native catalog; include unchanged official entries to keep those models.

The native smoke script now loads the complete committed `examples/models.json`
descriptor plus a synthetic native entry in an isolated temporary home. Against
Desktop **26.1021.22027** / `codex-cli 0.164.0-alpha.11.1`, it verifies:

- Three completed external-provider turns report a 996147-token usable window
  from the configured 1048576 raw window and 95% usable fraction.
- Low and max efforts reach the localhost Responses endpoint as native scalars.
- Synthetic reported input usage of 800000 does not trigger compaction; 900001
  triggers one native `contextCompaction` before the third user turn. Four
  upstream requests complete: three normal turns and one local compaction.
- Resume/fork retain the original custom provider and the global default remains
  OpenAI. The tested native lifecycle needs an explicit matching `modelProvider`
  to avoid falling back to its startup provider; the runtime now sends the
  verified existing binding rather than relying on backend defaults.

These are real native-backend operations with synthetic Responses usage. They
verify context resolution and compaction decisions, not an external provider's
ability to process an actual million-token prompt. No account credentials or
external inference are used.

Static native catalogs normally allow a model-picker availability shortcut.
The visibility transform disables that shortcut for unregistered entries, so
official entries still pass the original account/access-program checks. Only
explicitly registered external entries use the custom-model branch.

The real-archive harness locates tracing/effort helper bindings structurally,
instead of relying on one build's minified names. Run `check`, patch, repeated
`check`, and `verify-upstream.mjs` on disposable archives; installed applications
must remain unchanged. Full interactive Electron verification and real-provider
long-context inference remain outside these tests.

All 43 synthetic tests, type checking, build, formatting, and version consistency
passed. Disposable original archives for **26.1007.71326** and **26.1021.22027**
passed the check/patch/check cycle and actual upstream method tests, including
official availability filtering with `hasConfiguredModelCatalog = true`.

## Automatic composition and template inheritance (2026-11-08)

The new host-side `catalog` and `launch` commands read native cache metadata and
an external-only specification. Synthetic tests cover unchanged official entries,
complete prompt/capability inheritance, recursive overrides, explicit false/null
and array replacement, native-ID collisions, missing templates, invalid budgets,
atomic failure behavior, output/source alias protection, regeneration from updated
native data, and launch ordering/arguments/exit codes. The Node-only composer is
not injected into renderer assets.

The native smoke now generates its catalog using a synthetic `gpt-6-sol` template
and `examples/external-models.json`. It verifies inherited instructions reach the
Responses request along with tools, while retaining the context/compaction and
provider checks above.

A separate private-cache probe on Desktop **26.1021.22027** verified six registered
external models inherit every unspecified field from the actual local
`gpt-6-sol` entry, including the full `model_messages` bundle. Native entries were
equal to the source cache, without the earlier manually expanded default windows.
Model windows remained 950000 or 996147 usable tokens, matching their explicit
external limits.

Exact inheritance of `use_responses_lite = true` produced the internal Lite header
and omitted prompt/tool declarations. The user chose an explicit `false` override
for external entries. A subsequent localhost probe showed developer prompt
messages and seven tool declarations, no Lite header, and successful turns,
compaction and resume/fork. This proves native serialization, not compatibility
of every inherited GPT tool, service tier, or multi-agent protocol with the real
external providers. No live provider inference or credential helpers were used.

The generated catalog remains a startup snapshot. Launch-time regeneration uses
the newest locally available native cache; it does not fetch account catalogs or
refresh the running app-server. Missing cache/template data fails clearly rather
than silently switching templates or reusing stale generated data.
