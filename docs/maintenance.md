# Maintenance

## Updating structural matching

1. New Desktop versions need no version registration. Run `check` against the
   clean app archive to discover the patch points without writing anything.
2. If the structure no longer matches, inspect renderer request, prewarm,
   default-selection, visibility, and effort-selection boundaries. Confirm the
   native provider fields and response contracts still have their expected
   meanings. Update `src/patch/transforms.ts` with synthetic regression fixtures.
   Keep one logical match per patch point even when it needs multiple source
   edits. Prefer boundary insertions for wrappers that contain other patch
   targets; overlapping source replacements must still fail before writing.
3. Run type checking, tests, formatting, and the package build. Apply the patch
   to a disposable archive and repeat `check` to verify integrity and idempotence.
4. Test native and third-party models in separate chats, follow-up turns,
   prewarming, restart/resume, history, and default-model selection. Validate a
   simple tool call as well as text; inspect routing rather than trusting a
   model's self-identification.
5. Record evidence in the compatibility document. Updating `nix/upstream.json`
   adds a newer CI fixture without changing which versions the patcher accepts.

## CI

`.github/workflows/ci.yml` runs on main pushes, pull requests, and manual dispatch.
It uses SHA-pinned Actions, the checked-in nixpkgs lock, and read-only repository
permissions. It runs `nix flake check` and builds the tool.

`.github/workflows/release.yml` runs when an existing GitHub Release is published,
including pre-releases. It checks out the Release tag, repeats the source and
upstream checks, builds with Nix, and packages only the compiled tool, production
dependencies, examples, license, README, and source revision metadata. The tag
must equal `v<package.json version>`; the compiled patch version must also match.
`scripts/build-release.mjs` normalizes Nix Node shebangs, rejects remaining store
references and escaping symlinks, and creates a deterministic versioned tarball
and `SHA256SUMS`. No Desktop archive, credentials, or user configuration is copied.

The generic archive is then passed to six native runners: Linux, macOS, and
Windows, each on x64 and ARM64. `scripts/build-standalone.mjs` verifies the generic
archive and adds the matching official Node runtime and its license. Runtime
versions and distribution hashes are pinned in `scripts/node-runtime.json`;
verify updates against the version-specific official `SHASUMS256.txt`. The
unmodified runtime preserves its upstream signature where present. Launchers use
the bundled binary by path, with a `.cmd` entry point on Windows. These packages
retain the real on-disk runtime modules needed for ASAR injection.
The generic tarball uses 1970 timestamps for reproducibility. Windows ZIP staging
normalizes timestamps to 2000 (inside ZIP's supported date range), without
changing file contents or runtime signatures. PowerShell archive errors terminate
the build rather than continuing with a missing or incomplete archive.

`scripts/verify-standalone.mjs` extracts each final archive to a path containing
spaces and launches it with an empty PATH. It checks the bundled runtime's
version/architecture, CLI exit codes, catalog generation, and synthetic ASAR
check/patch/idempotence, then reads the result through `@electron/asar` as an
independent reader. Verification needs the build runner's Node 24 for the test
driver and synthetic fixtures; users do not need a separately installed runtime.

Only after the generic and all six native packages pass does the separate upload
job run with `contents: write`. It merges and verifies checksums, then attaches
all seven archives and `SHA256SUMS` to the existing published Release. Manual
dispatch accepts the same Release tag for retries; `publish: false` retains only
temporary workflow artifacts. Leaving `tag` empty tests the selected branch
without publishing, useful before tagging a new version:

```sh
gh workflow run release.yml --ref main -F publish=false
```

Re-running publication replaces assets with the same names. The workflow never
creates a Release or publishes to npm.
See GitHub's [Release event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
for the `published` trigger and the CLI's
[upload documentation](https://cli.github.com/manual/gh_release_upload) for retry
behavior. Releases created by another workflow using
[`GITHUB_TOKEN`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)
do not trigger another workflow; publish through the UI/CLI with a user token or
manually dispatch this workflow in that case.

The generic package still needs Node.js 22 or newer. Platform packages include
Node 24 and need only the OS facilities required by that official binary. Linux
targets glibc, with no musl package; NixOS users need `nix-ld` or the source flake.
The source-flake consumer and its source builds remain unchanged. Native CLI
smoke tests do not certify the graphical app or every Desktop archive on macOS
and Windows; structural discovery continues to decide compatibility.

Keep `package.json`, `package-lock.json`, and `PATCH_VERSION` in
`src/patch/constants.ts` consistent when updating the tool itself.
`scripts/check-versions.mjs` checks only these tool versions; it never checks the
Desktop version. Nix reads the tool version from package.json. Refresh
`npmDepsHash` whenever the lockfile changes, including version-only changes.

## Local NixOS consumer

The consumer uses `github:thericardoli/codex-desktop-providers` as a flake input,
with `inputs.nixpkgs.follows = "nixpkgs"`. Its overlay takes the exported default
package. The tool builds from source using the consumer's nixpkgs and performs
its source checks locally. There is no dependency on Release assets.

`flake.lock` pins the patch source commit and NAR hash. The Desktop version and
official download hash belong to the consumer's own Desktop derivation, which
invokes the tool during `postPatch`. The patcher's version and CI fixture do not
select or constrain the consumer's Desktop version.

To update the patch source:

```sh
cd /home/ricardo/nixos-config
nix flake update codex-desktop-providers
nix build 'path:.#chatgpt' --no-link
```

To update Desktop, edit its version and official download hash in the local
Desktop derivation, then build normally. A structural mismatch produces a
specific patch-point error without modifying the archive. Normal builds do not
move the lock or download a floating latest version.

For local development, use
`--override-input codex-desktop-providers path:/home/ricardo/projects/codex-desktop-providers`
without changing the normal GitHub input. For package/overlay changes, run the
consumer flake check, NixOS closure build, and Home Manager activation-package
build. Building must not switch the live system.

## Rollback

For catalog configuration, maintain `external-models.json` and point native
`model_catalog_json` at the generated output. The `launch` command regenerates
that output from the native cache before starting the packaged app. Do not edit
the generated file or store native prompts/cache snapshots in this repository.
Use an explicit absolute packaged application path to avoid launcher recursion.
Refreshing the native cache remains a native Codex operation; the plugin never
invokes credential helpers or maintains authentication of its own.

When changing a user-level launcher, back up its previous file/symlink and native
config, validate the generated catalog on an isolated backend, and publish the
new input/config paths before restarting. A user-level local build override does
not update the consumer's GitHub lock or activate a NixOS/Home Manager generation.

Disable/remove the patch invocation in the consumer package and rebuild from the
original upstream source, or return to a previous Nix generation. Remove a model
profile to stop listing it. The patch does not migrate databases, rewrite login
credentials, or alter existing session records. Rebuild from clean upstream when
upgrading an already patched archive rather than applying a different patch on
it directly.
