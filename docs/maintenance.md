# Maintenance

## Updating structural matching

1. New Desktop versions need no version registration. Run `check` against the
   clean app archive to discover the patch points without writing anything.
2. If the structure no longer matches, inspect renderer request, prewarm,
   default-selection, visibility, and effort-selection boundaries. Confirm the
   native provider fields and response contracts still have their expected
   meanings. Update `src/patch/transforms.ts` with synthetic regression fixtures.
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
permissions. It runs `nix flake check` and builds the tool. There is no Release
job, tag trigger, artifact upload, portable bundle, or prebuilt installer.

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

Disable/remove the patch invocation in the consumer package and rebuild from the
original upstream source, or return to a previous Nix generation. Remove a model
profile to stop listing it. The patch does not migrate databases, rewrite login
credentials, or alter existing session records. Rebuild from clean upstream when
upgrading an already patched archive rather than applying a different patch on
it directly.
