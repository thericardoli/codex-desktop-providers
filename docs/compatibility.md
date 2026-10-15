# Compatibility

| Desktop version | Platform     | Status                                  |
| --------------- | ------------ | --------------------------------------- |
| 26.1007.71326   | Linux x86_64 | Explicit adapter and asset fingerprints |

The adapter modifies these two assets:

- `webview/assets/app-shared-6fc3d63f0486.js`: request, prewarm, default selection
- `webview/assets/app-initial-17317d71fd80.js`: visibility of registered models

The actual SHA-256 values live in `src/patch/adapters.ts`. Both version and hashes
must match, followed by exactly one structural match for every patch point.
Version strings alone are insufficient because release variants can contain
different JavaScript assets.

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
