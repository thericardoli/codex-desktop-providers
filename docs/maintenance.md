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

The consumer uses a specific GitHub Release archive as a non-flake source input.
Its NAR hash is pinned in `flake.lock`. The included Nix installer recognizes
`release.json`, validates metadata, copies compiled files, and wraps them with
Nix's Node.js. `codex-desktop-providers.desktop` supplies the compatible Desktop
version and download hash to the existing local Desktop derivation.

To upgrade, change the release tag in the input URL,
then refresh only that input and review the lock diff:

```sh
cd /home/ricardo/nixos-config
nix flake update codex-desktop-providers
nix build 'path:.#chatgpt' --no-link
```

No floating `latest` lookup happens during evaluation or builds. A stale or
modified asset fails the locked hash check. Desktop asset hashes and structural
checks still run during local packaging. The built-in provenance file identifies
the source commit used by CI; SHA256SUMS supports manual downloads.

For overlay/flake changes, also run the consumer repository's flake check,
NixOS closure build and Home Manager activation-package build. Activation is a
separate user action; building alone must not switch the live system.

## Rollback

Disable/remove the patch invocation in the consumer package and rebuild from the
original upstream source, or return to a previous Nix generation. Remove a model
profile to stop listing it. The patch does not migrate databases, rewrite login
credentials, or alter existing session records.
