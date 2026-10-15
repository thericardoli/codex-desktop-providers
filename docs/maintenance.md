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
6. Update the compatibility document with evidence and limitations. Update the
   Nix package version and npm dependency hash when dependencies change.

## Local NixOS consumer

The consumer uses `git+file:///home/ricardo/projects/codex-desktop-providers` as a
local source input, pinned to a commit. Commit reviewed source changes before
refreshing the input. Generated files and development dependencies are excluded
from the Git source snapshot, and the derivation additionally filters them.
For a shared deployment, replace the local Git URL with a published Git revision.

Refresh the input after source changes:

```sh
cd /home/ricardo/nixos-config
nix flake update codex-desktop-providers
nix build 'path:.#chatgpt' --no-link
```

For overlay/flake changes, also run the consumer repository's flake check,
NixOS closure build and Home Manager activation-package build. Activation is a
separate user action; building alone must not switch the live system.

## Rollback

Disable/remove the patch invocation in the consumer package and rebuild from the
original upstream source, or return to a previous Nix generation. Remove a model
profile to stop listing it. The patch does not migrate databases, rewrite login
credentials, or alter existing session records.
