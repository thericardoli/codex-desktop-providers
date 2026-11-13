# Changelog

## 0.6.1

- Add packages containing the official Node runtime for Linux, macOS, and Windows
  on x64 and ARM64. Extract and run the included launcher without installing Node,
  npm dependencies, a compiler, or Nix.
- Pin each Node archive's SHA-256 hash, retain its license, and record runtime
  provenance alongside the compiled tool's source revision.
- Exercise the extracted package on all six native CI runners with an empty PATH,
  including catalog generation and synthetic ASAR check/patch/idempotence.
- Allow a manual build of the selected branch without publishing Release assets.
- Convert ASAR paths for the host reader on Windows and retain file flushing and
  atomic catalog replacement without an unsupported Windows directory fsync.

## 0.6.0

- Attach a compiled patch-tool archive with production dependencies and SHA-256
  checksums whenever a GitHub Release is published, with manual upload retries.
- Build Nix consumers from the source flake instead of prebuilt installers;
  keep main/PR source checks separate from the Release workflow.
- Attempt every Desktop version without version or asset-fingerprint allowlists.
- Discover all five patch points across renderer assets, supporting renamed,
  nested, merged, and split modules with relative runtime imports.
- Keep unique structural matches, atomic ASAR writes, idempotence, and installed
  patch integrity checks.
- Decouple the CI Desktop fixture from the consumer's own Desktop version pin.
- Generate native model catalogs from sparse external overrides, inheriting the
  selected native template while preserving official model entries unchanged.
- Regenerate the catalog before launching Desktop; reject legacy inline profile
  model metadata and keep native profiles responsible for provider routing.
- Support anonymous model filters nested inside newer Desktop effort selectors.

## 0.5.0

- Build and test with GitHub Actions; publish portable patch-tool archives and
  checksums on matching version tags.
- Install compiled release archives directly with Nix, without a binary cache,
  local TypeScript compilation, or npm dependency installation.
- Expose one shared Desktop version/download/adapter manifest to the patch and
  Nix consumer; check package and patch version consistency in CI.
- Validate the real upstream archive in a disposable Nix build before release.
- Correct the GLM-5.3-Flash preset to low/high/max, retaining high as the configured
  default, and distinguish API acceptance from native model capability.

## 0.4.0

- Require one model profile with a `model_reasoning_efforts` list and a native
  scalar default; validate list contents and default membership.
- Remove multi-profile effort aggregation and scalar-only compatibility.
- Keep the native singular effort key scalar so CLI and app-server config loads.

## 0.3.0

- Add optional profile `model_name` for readable model-menu labels, retaining a
  provider suffix to distinguish identical names on different routes.
- Recover display metadata from native raw config layers while preserving
  effective provider/auth configuration and upstream model IDs.
- Validate names and shared effort-variant metadata; retain backward-compatible
  model-ID labels when no name is configured.

## 0.2.0

- Merge same-model/provider native profiles into selectable reasoning strengths.
- Preserve declared custom choices through desktop effort filtering.
- Respect explicit effort, remember the session default for prewarming, and keep
  native per-chat effort on follow-ups and resume.
- Exercise the real patched effort selector and native low/max requests.

## 0.1.0

- Support desktop 26.1007.71326 on Linux x86_64 with exact asset fingerprints.
- Add models from native profiles alongside official subscription models.
- Use native direct-provider requests and authentication, including prewarming.
- Keep existing chats bound to their provider and preserve the official default.
- Apply atomic, verified ASAR changes with explicit compatibility failures.
- Provide TypeScript sources, automated tests, real-asset/backend smoke tools,
  development and maintenance documentation, and a standalone Nix package/flake.
