# Codex Desktop Providers

An independent, version-checked patch that adds directly connected third-party
models to Codex Desktop's native model menu alongside ChatGPT subscription models.
It reuses Codex's provider configuration, credentials, transport, and agent loop.

There is no local gateway and no protocol translation. An upstream provider must
support Codex's Responses API requests, streaming, and tool calling.

Currently supported: Linux x86_64 desktop **26.1007.71326**. The application is
proprietary; this repository contains the patch and synthetic tests only.

## Configure models

Keep your existing `~/.codex/config.toml` provider, including its authentication:

```toml
[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"
# Keep your existing env_key OR [model_providers.openrouter.auth] configuration.
```

Register a model using a native Codex profile:

```toml
[profiles.openrouter-glm-5-3-flash]
model = "z-ai/glm-5.3-flash"
model_provider = "openrouter"
model_reasoning_effort = "high"
model_context_window = 1048576
```

You do not select this as the global `profile`. The patch reads profiles and
lists explicit third-party model/provider pairs in the menu. Profiles without
both fields, and profiles using `openai`, do not add entries. Keep the global
`model_provider` unset or `"openai"`; keep your normal official model as the global
default. No global custom model catalog is required.

Restart the patched desktop after registration. Start a **new local Codex chat**
and select `z-ai/glm-5.3-flash (OpenRouter)`. Official model entries retain their
native availability checks and use your existing ChatGPT login.

## Configure selectable reasoning effort

Profiles with the **same model and provider** merge into one model menu entry.
Each profile's `model_reasoning_effort` adds a selectable strength. For example,
keep the main profile above as the default and add:

```toml
[profiles.openrouter-glm-5-3-flash-low]
model = "z-ai/glm-5.3-flash"
model_provider = "openrouter"
model_reasoning_effort = "low"

[profiles.openrouter-glm-5-3-flash-max]
model = "z-ai/glm-5.3-flash"
model_provider = "openrouter"
model_reasoning_effort = "max"
```

This exposes **low / high / max**, with **high** as the default. The
alphabetically first profile for a model determines its default; the unsuffixed
main profile sorts before its `-low` and `-max` variants. Effort options are
deduplicated and ordered by strength. Other overlapping model-tuning values must
agree; variant profiles may omit shared tuning such as context-window size.
Removing an effort profile removes that choice after config reload/restart.

Select the strength using the existing desktop reasoning/power selector. The
patch retains declared third-party choices through native model-list filtering,
forwards the chosen effort in both ordinary and collaboration-mode requests,
and applies it to new-chat prewarming. Omitted effort on follow-ups and resume
preserves native per-chat state. An unsupported stale value inherited from a
different model falls back to this model's configured default. Session default
selection remains in memory; it does not change global OpenAI settings.

GLM-5.3-Flash natively supports `low`, `high`, and `max`; other values
(including `medium`) fall back to `max` in its official chat template. Our main
profile deliberately keeps `high` as the configured default, while the model's
own omitted-parameter default is `max`. See the [official model card](https://huggingface.co/zai-org/GLM-5.3-Flash#note).

Register only strengths your upstream supports. Native effort names accepted by
the patch are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and
`ultra`; configuration alone does not add a capability to an upstream model.

Picker metadata advertises text input conservatively. Registration does not
prove a provider supports every Codex tool, image format, or advanced desktop
feature; inference capabilities remain controlled by the actual provider/backend.

## Build and check

Node.js 22 or newer is required. All dependencies are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run format:check
node dist/cli.js check --asar /path/to/app.asar
```

The `check` command verifies compatibility and prints the planned manifest without
writing anything. To apply to a **disposable copy** or a package build directory:

```sh
node dist/cli.js patch --asar /build/chatgpt/usr/lib/chatgpt/resources/app.asar
```

An existing identical patch is verified and left untouched. A different patch,
unsupported app version, mismatched asset hash, or ambiguous structural match
fails before writing. Rebuild from the clean upstream package to update the patch.

## Nix

```sh
nix build .#codex-desktop-providers
nix flake check
```

`nix/package.nix` is also usable with `callPackage`, passing an explicit `source`
when consumed as a non-flake input. The tool runs its test suite during the build.

The NixOS configuration in `/home/ricardo/nixos-config` consumes this project via
a local Git flake input and applies the patch during the ChatGPT package's
`postPatch` phase. The lock pins a source commit, excluding generated files and
development dependencies. Source is copied into the Nix store: it is a build
dependency, not a runtime dependency on this checkout. When changing this project,
commit the reviewed change and refresh that input's lock. Runtime dependencies remain
the desktop's own native provider/auth support.

Building does not activate the configuration or restart a running desktop.
After activation, completely quit and reopen the app to load the patched assets.

## Boundaries

- Provider is fixed per chat. Attempting to select a different provider in an
  existing chat is rejected; start a new chat instead. Resume and prewarm paths
  reuse the same routing rules.
- Each registered model ID must identify one provider. The same upstream ID on multiple
  providers, or an ID already in the native catalog, is rejected as ambiguous.
- Third-party default selection uses the desktop's existing in-memory override.
  It does not rewrite the global OpenAI default and is not persisted across app
  restarts.
- Only local Codex chats are patched. Remote/cloud chats, ChatGPT Work, arbitrary
  protocol conversion, cross-provider subagents, and quota-lock workarounds are
  outside this project's current scope.
- This patch does not bypass account limits, model entitlements or approvals.

See [architecture](docs/architecture.md), [compatibility](docs/compatibility.md),
and [maintenance](docs/maintenance.md) for implementation details and update steps.
See [validation](docs/validation.md) for reproducible smoke-test commands and the
boundaries of the current verification.
