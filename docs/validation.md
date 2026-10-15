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
exclusion, global-default preservation, exact adapter matching, and ASAR metadata
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
passed using the backend bundled with the supported desktop release.

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

## Release distribution (0.5.0)

CI runs the source package checks and disposable upstream archive validation.
The portable release is built from Nix's installed production package and tested
again using the release's Nix installer, without TypeScript compilation or npm
installation. The release records its source revision and exact supported
Desktop version. Local consumer validation covers the downloaded archive input,
Desktop packaging, the NixOS closure, and Home Manager activation package.

The pipeline does not launch the graphical app or make authenticated model
requests. Existing real-backend smoke evidence above remains separate from the
release packaging checks.
