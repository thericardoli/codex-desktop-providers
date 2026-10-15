# Changelog

## Unreleased

- Correct the GLM-5.3-Flash preset to low/high/max, retaining high as the configured
  default, and distinguish API acceptance from native model capability.

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
