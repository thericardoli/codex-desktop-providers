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
model_name = "GLM 5.3 Flash"
model_provider = "openrouter"
model_reasoning_effort = "high"
model_reasoning_efforts = ["low", "high", "max"]
model_context_window = 1048576
```

You do not select this as the global `profile`. The patch reads profiles and
lists explicit third-party model/provider pairs in the menu. Profiles without
both fields, and profiles using `openai`, do not add entries. Keep the global
`model_provider` unset or `"openai"`; keep your normal official model as the global
default. No global custom model catalog is required.

Restart the patched desktop after registration. Start a **new local Codex chat**
and select `GLM 5.3 Flash (OpenRouter)`. Official model entries retain their
native availability checks and use your existing ChatGPT login.

## Configure model display names

Set `model_name` on a model's main profile to give it a readable label:

```toml
[profiles.ollama-glm-5-3-flash]
model = "glm-5.3-flash"
model_name = "GLM 5.3 Flash"
model_provider = "ollama-cloud"
model_reasoning_effort = "high"
model_reasoning_efforts = ["low", "high", "max"]
```

The menu shows `GLM 5.3 Flash (Ollama Cloud)`; the OpenRouter profile above shows
`GLM 5.3 Flash (OpenRouter)`. The provider suffix distinguishes the two routes.
`model` remains the exact upstream ID for requests, history, defaults, and
provider matching. Names are presentation metadata and never enter inference
configuration or request model IDs. Native OpenAI names are left unchanged.

Each model has one profile and one display name. Leading/trailing whitespace is
trimmed, and non-string or blank names are rejected. Omitting `model_name`
displays the upstream model ID.

`model_name` is a **desktop patch extension**, not a native Codex inference key.
The normalized native config omits it, so the patch reads this display field and the effort list
from enabled, non-project raw config layers in native precedence order. Native
Codex may log that it ignores this extension key; the patched desktop consumes
it independently. The unpatched CLI continues to use the underlying model ID.

## Configure selectable reasoning effort

Use **one profile per model**. Declare its selectable strengths as a list:

```toml
[profiles.ollama-glm-5-3-flash]
model = "glm-5.3-flash"
model_name = "GLM 5.3 Flash"
model_provider = "ollama-cloud"
model_reasoning_efforts = ["low", "high", "max"]
model_reasoning_effort = "high"
```

- `model_reasoning_efforts` (plural) is required and declares the supported list.
- `model_reasoning_effort` (singular) is the native default. It must occur in the
  list. If omitted, the patch uses the first declared list item for new chats.
- The list must be nonempty, contain recognized effort names, and have no
  duplicates. The menu orders them by strength.
- Register only one profile for each model ID. Old multi-profile effort variants
  and scalar-only registrations are rejected; there is no compatibility shim.

The native singular key accepts one enum value. Assigning an array to it prevents
native Codex from loading the whole configuration. The plural list is a patch
extension read from enabled raw config layers, just like `model_name`. It is not
forwarded to inference: the selected effort is sent as one native scalar value.

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

## Nix: download a release

GitHub Actions checks every push and pull request. Pushing a version tag such as
`v0.5.0` publishes a compiled, portable tool with its production dependencies,
Nix installer, release provenance, and a separate `SHA256SUMS` file. No Desktop
archive or credentials are distributed. No Cachix account or signing key is
needed for this release-download approach.

Use the release archive directly as a **non-flake input**:

```nix
inputs.codex-desktop-providers = {
  url = "https://github.com/thericardoli/codex-desktop-providers/releases/download/v0.5.0/codex-desktop-providers.tar.gz";
  flake = false;
};
```

In your package overlay:

```nix
codex-desktop-providers = final.callPackage "${inputs.codex-desktop-providers}/nix/package.nix" {
  source = inputs.codex-desktop-providers;
};
```

The release installer copies the compiled files and creates a wrapper using
Nix's Node.js. It does not install npm dependencies or compile TypeScript.
`flake.lock` pins the unpacked archive's NAR hash; modifying the remote asset
cannot silently change an already locked deployment. GitHub's automatically
created source tarball is different: it builds the project from source.

The tool exposes `passthru.desktop` as the authoritative supported Desktop
version, download URL, and hash. A consuming desktop derivation can use:

```nix
let
  desktop = codex-desktop-providers.desktop;
in
stdenvNoCC.mkDerivation {
  pname = "chatgpt";
  inherit (desktop) version;
  src = fetchurl { inherit (desktop) url hash; };
  nativeBuildInputs = [ codex-desktop-providers ];
  postPatch = ''
    ${lib.getExe codex-desktop-providers} patch \
      --asar usr/lib/chatgpt/resources/app.asar
  '';
  # Keep the rest of your existing Desktop packaging here.
}
```

The local consumer in `/home/ricardo/nixos-config` uses this arrangement. Updating
the release input and lock updates the patch and supported Desktop together.
Never use a floating `latest` download URL. See [maintenance](docs/maintenance.md)
for release and upgrade commands.

For development, the Git checkout remains buildable from source:

```sh
nix build .#codex-desktop-providers
nix flake check
```

Source checks include version consistency, type checking, unit tests, formatting,
and a disposable upstream archive test. Release downloads only need the light
installation step. Node.js itself comes from the consumer's nixpkgs; matching the
CI nixpkgs revision is unnecessary for this portable JavaScript archive.

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
