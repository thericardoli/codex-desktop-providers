# Architecture

The build-time CLI is Node.js/TypeScript. The injected renderer modules are plain
ES modules emitted by the TypeScript compiler; they have no Node.js dependencies
and no HTTP client. There is no daemon or inference proxy to run.

## Data flow

1. The native renderer request client receives `model/list`.
2. The runtime reads the effective native config and raw layers with `config/read`. It retains
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

`src/patch/transforms.ts` locates five semantic boundaries with Acorn:

- `AppServerRequestClient.sendRequest`
- `AppServerRequestClient.prewarmThreadStart`
- The conversation manager's `setDefaultModelConfig`
- The model visibility predicate, identified by destructured property names
  and its access-program check rather than a minified function name
- The model/effort selector, restoring explicitly registered third-party options
  after native account-level filtering while retaining native model behavior

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

`model_name` and required `model_reasoning_efforts` are read from the effective profile when present or from
enabled, non-project raw layers (highest precedence first). Native config
normalization drops these extension fields. Only presentation/capability metadata
is recovered from raw layers; routing/auth still use native effective config.
Each model has one profile; repeated model registrations fail clearly.
Only the menu's `displayName` changes; the `id`, `model`, thread parameters,
history identity and provider mapping remain the upstream ID.

Each profile declares a nonempty, duplicate-free list of reasoning efforts. The
native singular `model_reasoning_effort` supplies its default, or the first list
item is used if no default is configured. Only selected scalar effort is forwarded
to inference. Explicit request effort takes precedence over in-memory selection,
then the profile default. Missing effort on follow-ups/resume is left to native
per-chat persistence, so changing to low is not undone by the next turn. No legacy
multi-profile merging or scalar-only compatibility path remains.
