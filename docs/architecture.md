# Architecture

The build-time CLI is Node.js/TypeScript. The injected renderer modules are plain
ES modules emitted by the TypeScript compiler; they have no Node.js dependencies
and no HTTP client. There is no daemon or inference proxy to run.

## Data flow

1. The native renderer request client receives `model/list`.
2. The runtime reads the effective native config with `config/read`. It retains
   only registered model metadata and model tuning, not provider credentials.
3. Native models are left intact and explicit third-party profiles are appended.
   Only those tagged additions bypass the desktop's official catalog filter.
4. At `thread/start`, the runtime adds `modelProvider` and whitelisted model
   tuning. Codex's app-server performs native provider authentication and makes
   the direct upstream request.
5. The native prewarm path gets the same transformation. Thread responses supply
   authoritative provider identity, cached per renderer request client.
6. Follow-up turns retain the provider. A cross-provider request fails before
   inference. Resuming a registered model verifies persisted thread metadata.

The runtime does not change tool execution, approvals, sandboxing, instruction
loading, plugins, credentials, or the native stream scheduler. Profile fields
unrelated to model tuning are deliberately not copied into thread overrides.

## Boundaries in upstream code

`src/patch/transforms.ts` locates four semantic boundaries with Acorn:

- `AppServerRequestClient.sendRequest`
- `AppServerRequestClient.prewarmThreadStart`
- The conversation manager's `setDefaultModelConfig`
- The model visibility predicate, identified by destructured property names
  and its access-program check rather than a minified function name

MagicString wraps the existing function bodies; scheduling, errors, and tracing
remain in the original implementation. Imports reference our own isolated ES
module directory, avoiding modifications to hashed upstream import graphs.

## Archive handling

The official `@electron/asar` reader parses and verifies entries. The writer
clones the original header, retains the entire original payload, and appends
changed/new packed assets. Existing unrelated offsets and metadata are preserved,
including `.unpacked` resources outside the archive. Changed entries receive
fresh SHA-256 whole-file and block integrity records.

All modifications are planned in memory first. A sibling temporary archive is
written, flushed, and independently read back before an atomic rename. The source
file's identity, size, and modification time must remain unchanged during writing.
The installed desktop is never an implicit patch target.

## State

Config discovery is cached for 30 seconds per client. Observed thread-provider
metadata is bounded to 512 entries; missing custom-thread identity is resolved
with `thread/read`. The runtime does not persist its own routing database.

The desktop's own temporary model override holds third-party default selection.
This prevents UI selection from writing a third-party ID into the global OpenAI
configuration used by CLI and background tasks.
