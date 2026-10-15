# Maintenance

## Updating the desktop adapter

1. Obtain the clean application archive for the target desktop release in a
   build/research directory. Do not patch a running installed application.
2. Inspect the new renderer request, prewarm, default-selection and model filter
   boundaries. Confirm the native provider fields and response contracts still
   have the expected meanings.
3. Add an adapter with the exact app version, asset paths, and SHA-256 hashes.
   If the structural rules change, update them with synthetic regression fixtures.
4. Run type checking, tests, formatting, and the package build. Run `check` against
   the clean archive, then `patch` on a disposable copy. Repeat `check` to verify
   the installed manifest and idempotence.
5. Test a native model and a third-party model in separate chats, their follow-up
   turns, prewarming, restart/resume, sidebar history and default-model selection.
   Validate a simple tool call as well as text; inspect request routing rather
   than trusting a model's self-identification.
6. Update the compatibility document with evidence and limitations. Update package.json, package-lock.json and PATCH_VERSION together. Refresh
   npmDepsHash whenever the lockfile changes, including version-only changes.

## CI and releases

The workflow `.github/workflows/ci.yml` runs on main pushes, pull requests, version
tags, and manual dispatch. It uses SHA-pinned Actions and the checked-in nixpkgs
lock. The build job has read-only repository permissions. Only the tag release
job gets `contents: write`, using GitHub's built-in token; no personal token or
external cache credentials are required.

1. Update `package.json`, `package-lock.json`, and `PATCH_VERSION` together.
   `scripts/check-versions.mjs` rejects mismatches. Nix reads its version directly
   from package.json. Refresh `npmDepsHash` if the lockfile changed.
2. Update `src/patch/compatibility.json` when supporting a new Desktop. It owns
   the Desktop version, official download URL/hash, and reviewed asset adapters.
   Keep the AST transformations and real-archive checks compatible.
3. Run `nix flake check "path:$PWD"`. It checks the source package and downloads
   the pinned original Desktop to exercise the patch on a disposable archive.
   The archive is used only during validation and is never published.
4. Commit and push the reviewed changes, then push a matching version tag:

   ```sh
   git tag v0.5.0
   git push origin main v0.5.0
   ```

5. CI builds a portable archive using `scripts/build-release.mjs`, strips Nix
   Node shebangs, checks for escaping symlinks/store references, records the source
   commit, and fixes archive metadata for reproducibility. It tests the archive's
   Nix installer before publishing the archive and SHA256SUMS to GitHub Releases.
   The tag must match the package version. Published tags/releases must not be
   overwritten; issue a new patch version for corrections.

The archive contains compiled JavaScript and production npm dependencies, not a
Node binary or a Nix store closure. Source builds remain available from the Git
checkout. GitHub Actions artifacts are temporary CI output; the versioned GitHub
Release asset is the deployment input.

## Local NixOS consumer

The consumer uses `github:thericardoli/codex-desktop-providers` as a flake input,
with `inputs.nixpkgs.follows = "nixpkgs"`. Its overlay takes the exported default
package. The tool builds from source using the consumer's nixpkgs and performs
its source checks locally. This does not depend on tags, releases, CI artifacts,
or prebuilt binaries.

`flake.lock` pins the exact source commit and NAR hash. The package exposes
`codex-desktop-providers.desktop`, which supplies the compatible Desktop version,
URL, and download hash to the existing local Desktop derivation. A source update
therefore updates both halves of the supported combination; a Desktop version
without a reviewed adapter is never selected implicitly.

To upgrade to the current reviewed main branch:

```sh
cd /home/ricardo/nixos-config
nix flake update codex-desktop-providers
nix build 'path:.#chatgpt' --no-link
```

Review the locked revision and build result before applying the configuration.
Normal builds do not move the lock. Roll back the input lock to restore the
previous patch/Desktop combination. For local development, use
`--override-input codex-desktop-providers path:/home/ricardo/projects/codex-desktop-providers`
without changing the normal GitHub input.

The optional release archive is a separate distribution mode described in the
README. It is not part of this consumer's build or upgrade path.

For overlay/flake changes, also run the consumer repository's flake check,
NixOS closure build and Home Manager activation-package build. Activation is a
separate user action; building alone must not switch the live system.

## Rollback

Disable/remove the patch invocation in the consumer package and rebuild from the
original upstream source, or return to a previous Nix generation. Remove a model
profile to stop listing it. The patch does not migrate databases, rewrite login
credentials, or alter existing session records.
