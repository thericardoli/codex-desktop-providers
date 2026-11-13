# Project instructions

This is an independent TypeScript patch project, not a model gateway.

- Preserve native OpenAI authentication and native model entitlement checks.
- Reuse native `model_providers` and explicit native `profiles`; never add a
  second credential store, read auth.json, or invoke credential helpers.
- Only a new thread may choose a provider. Do not silently move an existing
  thread between providers or rewrite thread databases/history.
- Keep runtime logic in `src/runtime`, archive/adapter work in `src/patch`,
  and Nix packaging in `nix/package.nix`.
- Attempt every Desktop version without a version or asset-hash allowlist.
  Discover patch points structurally across renderer assets. Missing, ambiguous,
  or overlapping matches must fail before modifying the archive.
- Main/PR CI validates and builds source only. The separate Release workflow
  attaches the compiled patch tool and checksums to an existing published Release;
  never include the upstream Desktop application or user data.
- Preserve unrelated ASAR payloads, native modules, links, executable bits, and
  unpacked metadata. Archive changes must be atomic and checked by an independent
  ASAR reader.
- Never commit extracted application bundles, user configs, tokens, or logs.
- Use synthetic fixtures for unit tests. Test the real application archive with
  `check` and on a disposable copy, never by modifying an installed app.
- Run `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run format:check` after TypeScript changes. Run `nix flake check` for
  packaging changes and format changed Nix files with nixfmt.
- Record version-specific findings and remaining limitations in `docs/`.
