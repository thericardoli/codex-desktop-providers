# Codex Desktop Providers

An independent, structure-based patch that adds directly connected third-party
models to Codex Desktop's native model menu alongside ChatGPT subscription models.
It reuses Codex's provider configuration, credentials, transport, and agent loop.

There is no local gateway and no protocol translation. An upstream provider must
support Codex's Responses API requests, streaming, and tool calling.

Every Desktop version is eligible: there is no version or source-hash allowlist.
The patch discovers its code boundaries across renderer modules, independently
of hashed filenames and bundling layout. Missing or ambiguous structural matches
fail before writing. Tested on Linux x86_64 desktops **26.1007.71326** and
**26.1021.22027**; this is test
evidence, not a compatibility restriction. The application is proprietary; this
repository contains the patch and synthetic tests only.

## Configure only external models

Maintain a small **external-models.json** file. The plugin's `launch` command
reads the local native model cache, inherits external defaults from `gpt-6-sol`,
and atomically generates a complete `model_catalog_json` before starting Desktop.
Official entries are copied unchanged; you do not list or maintain them yourself.

Start with [examples/external-models.json](examples/external-models.json):

```json
{
  "template": "gpt-6-sol",
  "models": [
    {
      "slug": "z-ai/glm-5.3-flash",
      "display_name": "GLM 5.3 Flash",
      "description": "GLM 5.3 Flash via OpenRouter",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Low reasoning effort" },
        { "effort": "high", "description": "High reasoning effort" },
        { "effort": "max", "description": "Maximum reasoning effort" }
      ],
      "context_window": 1048576,
      "max_context_window": 1048576,
      "auto_compact_token_limit": 900000,
      "use_responses_lite": false
    }
  ]
}
```

Every unspecified field inherits the template, including the complete
`model_messages` bundle, instructions, tools, modalities and other metadata.
Nested objects merge recursively; arrays replace. Explicit `false`, `null`, empty
strings and empty arrays are preserved. Each external entry needs its own exact
`slug` and `display_name`; its ID must not collide with a native model.

The example explicitly disables `use_responses_lite`. With the tested native
backend, inheriting `true` sends OpenAI's internal Lite header and omits prompt
and tool declarations. With `false`, inherited prompts are sent as developer
messages and tools are included. Other inherited capabilities are declarations,
not proof that an external endpoint implements every GPT-specific tool or
multi-agent behavior. Add explicit per-model overrides when a provider needs them.

### Connect the generated catalog

Put the **generated** path at the top level of `~/.codex/config.toml`, before any
table. Profiles retain only provider routing:

```toml
model_catalog_json = "/absolute/path/to/desktop-providers.generated.json"
# Keep your normal official model as the global model.
# Keep model_provider unset or "openai".

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"
# Keep your existing native authentication configuration.

[profiles.openrouter-glm-5-3-flash]
model = "z-ai/glm-5.3-flash"
model_provider = "openrouter"
```

Do not select the external profile as the global `profile`. Each external model
needs one profile whose `model` exactly matches its catalog `slug`. Native provider
credentials remain in their existing configuration and are never copied into
catalog files.

Prepare the catalog without launching:

```sh
codex-desktop-providers catalog \
  --native-cache /absolute/path/to/.codex/models_cache.json \
  --external /absolute/path/to/external-models.json \
  --output /absolute/path/to/desktop-providers.generated.json
```

Use the launcher for automatic regeneration on each application start:

```sh
codex-desktop-providers launch \
  --native-cache /absolute/path/to/.codex/models_cache.json \
  --external /absolute/path/to/external-models.json \
  --output /absolute/path/to/desktop-providers.generated.json \
  --app /absolute/path/to/packaged/chatgpt -- "$@"
```

Configure the desktop shortcut or shell wrapper to invoke this command. `--app`
must point to the actual packaged launcher, not back to the wrapper itself. App
arguments after `--` are forwarded unchanged. A missing template, invalid source,
duplicate ID or write failure stops launch and leaves the previous valid catalog
intact. The generator never substitutes another model for a missing `gpt-6-sol`.

### Refresh and native behavior

The input cache is the native Codex cache, **not the previously generated file**.
Each launch picks up the latest entries and template already present in that
cache. The plugin does not fetch remote model metadata, read credential files,
invoke credential helpers, or modify `models_cache.json`. A missing/outdated
native cache must be refreshed through the normal native Codex workflow.

The backend still loads the generated catalog as a static snapshot at startup.
Running chats do not hot-reload changes; completely restart the app-server after
editing external settings or refreshing native metadata. A persistent daemon may
survive closing the Desktop window. Launch-time merging does not provide native
per-thread catalog switching or continuous server-side catalog refresh.

Official entries preserve the native cache's default windows and metadata, plus
normal account availability checks. They are not pinned in the user-maintained
external file. Global `model_context_window` and compaction overrides still apply
if present; remove them when each catalog model should supply its own defaults.

With the example overrides and a 95% usable fraction, the backend reports 996147
usable tokens and a 900000 automatic-compaction threshold. Names, supported
efforts, hidden flags and modalities are read from native `model/list`. Selected
effort remains a scalar; omitted follow-up effort preserves native per-chat state.
Resume/fork explicitly retain the verified provider, including model-less calls.

The older complete [models.json](examples/models.json) remains a low-level
standalone descriptor example and native smoke fixture. Prefer the sparse
external configuration and generated output for everyday use. Never commit
native cache snapshots, generated catalogs, or user configuration to this repo.

### Migrate old profiles

Move model settings out of inline profiles. The patch reports a migration error
for legacy fields, including fields discarded by native normalization, instead
of silently ignoring them.

| Old profile field                | Native catalog field                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| `model_name`                     | `display_name`                                                         |
| `model_reasoning_efforts`        | `supported_reasoning_levels` (objects with `effort` and `description`) |
| `model_reasoning_effort`         | `default_reasoning_level`                                              |
| `model_context_window`           | `context_window` and `max_context_window`                              |
| `model_auto_compact_token_limit` | `auto_compact_token_limit`                                             |
| `model_reasoning_summary`        | `default_reasoning_summary`                                            |
| `model_verbosity`                | `default_verbosity`                                                    |

Keep only `model` and `model_provider` for the registration. Other native profile
security/instruction settings are not copied into thread overrides. Supported
reasoning efforts must be nonempty, unique, recognized by Codex, and include the
declared default. For non-reasoning models declare `none` explicitly. Use the
same upstream ID for the catalog `slug` and profile `model`.

## Download a ready-to-run package

Download a platform package and `SHA256SUMS` from
[GitHub Releases](https://github.com/thericardoli/codex-desktop-providers/releases).
Choose the operating system and architecture of the machine running the tool:

| Operating system | x64 target    | ARM64 target    | Archive   |
| ---------------- | ------------- | --------------- | --------- |
| Linux            | `linux-x64`   | `linux-arm64`   | `.tar.gz` |
| macOS            | `macos-x64`   | `macos-arm64`   | `.tar.gz` |
| Windows          | `windows-x64` | `windows-arm64` | `.zip`    |

The filename is `codex-desktop-providers-<version>-<target>` with the archive
extension above. Extract it and run the included launcher from its directory:

```sh
# Linux and macOS
./codex-desktop-providers --help
./codex-desktop-providers check --asar /absolute/path/to/app.asar
```

```powershell
# Windows PowerShell
.\codex-desktop-providers.cmd --help
.\codex-desktop-providers.cmd check --asar 'C:\absolute\path\to\app.asar'
```

These packages contain compiled JavaScript, all production dependencies, and an
unmodified official **Node.js 24.22.3** runtime with its license. No Node install,
npm install, local compilation, or Nix is required. Keep the extracted directory
together; the launcher locates its own bundled runtime regardless of PATH or the
current working directory. `release.json` records the source revision and the
runtime's version, target, download URL, and verified SHA-256 hash.

Linux packages target glibc systems (kernel 4.18+, glibc 2.28+); macOS requires
13.5+ and Windows requires 10+. These follow the
[official Node runtime requirements](https://github.com/nodejs/node/blob/v24.22.3/BUILDING.md#platform-list).
Alpine/musl is not included. On NixOS, use the source flake below or an existing
`nix-ld` setup capable of running the official Node binary. Native CI tests check
all six packages with synthetic archives; real Desktop integration is currently
validated on Linux. Obtain the Desktop application separately.

The smaller `codex-desktop-providers-<version>.tar.gz` asset contains compiled
JavaScript and dependencies, and needs an existing Node.js 22+ installation:
run `node dist/cli.js --help` after extraction. GitHub's automatic `Source code`
archives contain source and require building.

### Windows: Microsoft Store / MSIX installations

`prepare-windows` is available in **0.6.2 and later**. Download the matching
Windows package above; older packages do not contain this command. From a source
build, replace `.\codex-desktop-providers.cmd` below with `node .\dist\cli.js`.

Use `prepare-windows` for an application installed under `WindowsApps`. It reads
the installed application and creates a complete patched copy in a new writable
directory. Direct `patch` inside WindowsApps is unsupported, including from an
elevated shell. `check` is read-only: `status: ready` means the archive's patch
points match, not that its directory is writable or the application will launch.

From PowerShell in the extracted patch-tool directory, locate the installed EXE
and choose a **new** output directory. For the installation in the reported issue:

```powershell
$app = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\app\Codex.exe'
$destination = Join-Path $env:LOCALAPPDATA 'CodexProviders\26.1106.6628.0-patched'
.\codex-desktop-providers.cmd prepare-windows --app $app --output $destination
```

Replace the package path and EXE filename with those on your machine. The selected
EXE must sit beside `resources\app.asar`. The destination must not already exist;
the tool creates `$destination\app` with the EXE, DLLs, resources, and unpacked
native modules. An incomplete copy is removed on failure. No extra Node install,
ACL changes, package registration or credential migration is needed to prepare it.

After success, fully quit the installed Desktop and start the exact `app` path
printed in the JSON result. Store/Start-menu shortcuts still point to the original
installation. For launch-time catalog generation, pass the returned EXE path to
the existing `launch --app ...` command. Configure providers and models using the
native configuration described above. For updates, prepare another new directory
from a clean updated application; retain the original installation for rollback.

Preparation checks Electron's embedded ASAR integrity and updates an existing
EXE digest when validation is enabled, preserving the validation fuse. With
validation disabled the EXE is copied byte-for-byte. Updating a signed EXE
invalidates the **copy's** publisher signature; the result reports this, and an
organization's signed-code policy may prevent it from running. Unsupported or
ambiguous EXE layouts fail before a prepared app is published.

This solves the protected-directory write failure. The copy is not an MSIX
registration: features requiring package identity, graphical startup, native
login and inference still need real Windows validation. `status: prepared` reports
verified files, and `runtimeValidation: not-performed` explicitly records that the
application was not started. See [Windows findings](docs/compatibility.md#windows-storemsix).

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

The `check` command verifies archive structure and prints the planned manifest
without writing anything. Its `target` field identifies standard WindowsApps
paths; other targets report `permissions-not-checked`. It does not probe write
access or certify graphical startup. To apply to a **disposable copy** or a package build directory:

```sh
node dist/cli.js patch --asar /build/chatgpt/usr/lib/chatgpt/resources/app.asar
```

An existing identical patch is verified and left untouched. A different installed
patch, damaged patched assets, or missing/ambiguous code boundaries fails before
writing. Rebuild from the clean upstream package to update the patch. Source
hashes are recorded for provenance, not compared against predefined values.
Desktop version strings are informational and never decide patch eligibility.

## Nix: build from the GitHub flake

Use the repository directly, sharing your existing nixpkgs input:

```nix
inputs.codex-desktop-providers = {
  url = "github:thericardoli/codex-desktop-providers";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

In your package overlay:

```nix
codex-desktop-providers = inputs.codex-desktop-providers.packages.${system}.default;
```

`flake.lock` pins a specific Git commit and source NAR hash. The URL may track the
repository's default branch, but normal builds keep using the locked revision.
The tool builds from source locally and runs version, type, unit-test, and format
checks. No release asset is required. This is the arrangement used by the local
consumer in `/home/ricardo/nixos-config`.

Keep the Desktop version and official download hash in your own existing Desktop
package. They are independent of this patch's version and the CI test fixture.
Add the tool as a build dependency and invoke it in your package's `postPatch`:

```nix
nativeBuildInputs = [ codex-desktop-providers ];
postPatch = ''
  ${lib.getExe codex-desktop-providers} patch \
    --asar usr/lib/chatgpt/resources/app.asar
'';
```

Build and check locally:

```sh
nix build .#codex-desktop-providers
nix flake check
```

CI checks and builds source on main pushes, pull requests, and manual dispatch.
Publishing a GitHub Release (including a pre-release) also runs
`.github/workflows/release.yml`, which checks and builds that tag, then attaches
the generic compiled archive, six packages with bundled runtimes, and a combined
`SHA256SUMS` to the existing Release after all native package checks pass.
Use a tag matching `v<package.json version>`. The workflow can also be dispatched
manually with an existing published Release tag to retry an upload. Leave the
manual tag empty to test the selected branch without publishing. Package download
and launcher instructions are above. Nix consumers continue to build from the
source flake.

Standalone flake checks download the original Desktop pinned in
`nix/upstream.json` and exercise the patch on a disposable archive. That pin is a
test fixture only: it is not read by the patcher or exported as the consumer's
Desktop version. New Desktop releases do not require updating a version allowlist.

Building does not activate the configuration or restart a running desktop.
After activation, completely quit and reopen the app to load the patched assets.

## Boundaries

- Provider is fixed per chat. Attempting to select a different provider in an
  existing chat is rejected; start a new chat instead. Resume and prewarm paths
  reuse the same routing rules.
- Each registered model ID must identify one provider and exactly one native
  catalog entry. Duplicate registrations or missing/duplicate catalog entries fail
  before inference. Entries are decorated in place, never appended a second time.
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
