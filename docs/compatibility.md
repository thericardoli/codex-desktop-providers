# Compatibility

The patch attempts **every Desktop version by default**. There is no app-version
allowlist, hardcoded renderer filename, or predefined upstream asset hash check.
The app's version is recorded in the patch manifest for diagnostics only.

It enumerates packed JavaScript modules under `webview/`, uses inexpensive code
markers to identify candidates, then locates five patch points with Acorn. Each
point must occur exactly once across the entire candidate set. The points may
move between files, combine into one module, or split across modules. Injected
runtime imports are relative to each discovered module's directory.

Matching code structure is the compatibility criterion. Missing, ambiguous,
malformed, or overlapping targets fail before the archive is modified. Changes
to the native request contracts may still require runtime updates; unrestricted
version eligibility is not evidence that untested code layouts or native APIs
work. No check is bypassed by pretending an unknown version is a tested version.

| Desktop version | Platform     | Evidence                                 |
| --------------- | ------------ | ---------------------------------------- |
| 26.1007.71326   | Linux x86_64 | Actual structural patch and method tests |

`nix/upstream.json` pins the official download used by CI. It is an integration
test fixture, not runtime compatibility data. Consumers independently select
their Desktop version and pin its download hash as usual for Nix packaging.

Original asset hashes are measured during planning and stored in the manifest.
Installed output hashes and runtime bytes are checked on a repeated invocation
to detect damage or a different patch. These integrity checks do not restrict
which clean upstream versions can be patched.

The current configuration's default provider must remain OpenAI. Third-party
models are added to the native model response only in the renderer, preserving
the official backend's original model catalog and authentication mode.

An OpenAI-compatible Chat Completions endpoint alone is insufficient. The provider
must accept Responses API inference, stream events, and the Codex tool schema.
OpenRouter's public catalog identifies the requested model as
`z-ai/glm-5.3-flash`; catalog presence alone is not an inference compatibility test.

This version does not solve desktop account/quota restrictions or guarantee
feature parity for third-party models. It does not modify the closed-source
desktop's account gating. Authentication helpers are executed only by native
Codex when it makes provider requests.
