# Architecture

The CLI is Node.js/TypeScript. Its build-time check/patch commands modify disposable
archives; host-side catalog/launch commands prepare metadata before application
startup. The injected renderer modules are plain ES modules with no Node.js
imports or HTTP client. The host-only `src/runtime/catalog.ts` module is not
injected into ASAR. There is no daemon or inference proxy.

## Startup catalog generation

The launcher reads an existing native `models_cache.json` and a user-authored
external-only specification. Official entries pass through unchanged. Every
external entry deep-merges its explicit overrides over one exact native template
(default example: `gpt-6-sol`). Nested objects merge, arrays replace, and explicit
null/false/empty values survive. Cache account/identity metadata is not written.

Generation validates identities, collisions, effort defaults and budgets before
writing. It fsyncs a private sibling temporary file, checks that source file
identities have not changed, and atomically renames the result. Source aliases,
credential-file inputs and symlink outputs are rejected. Generation failures
prevent launch. No process or helper is invoked to obtain credentials or refresh
remote metadata; existing native cache contents are the source.

The application still consumes a static startup catalog. Regeneration happens on
launch, not during a running conversation. Only the external specification is
maintained by the user; the combined catalog is disposable generated data.

## Data flow

1. The native renderer request client receives `model/list`.
2. The runtime reads effective native config with `config/read` and all pages of
   native `model/list`. Raw config layers are used only to diagnose legacy fields.
   The app-server has already loaded `model_catalog_json` at startup.
3. Explicit third-party profiles map catalog model IDs to providers. Matching
   entries receive a provider label/marker; all other entries remain unchanged.
   Names, efforts, modalities and hidden flags come from the native catalog.
4. At `thread/start`, the runtime adds `modelProvider` and selected scalar effort.
   Context windows, compaction, instructions and other capabilities remain native
   catalog settings. Codex performs native authentication and direct inference.
5. The native prewarm path gets the same transformation. Thread responses supply
   authoritative provider identity, cached per renderer request client.
6. Follow-up turns retain the provider. Resume/fork verifies persisted metadata
   and explicitly sends the same provider, including model-less requests. A
   cross-provider request fails before inference.

The runtime does not change tool execution, approvals, sandboxing, plugins,
credentials, or the native stream scheduler. Profile security/instruction fields
are never copied into thread overrides. Model instructions and capabilities in
user-authored native catalogs are consumed by the native backend as usual.

A single static catalog replaces dynamic native model discovery for this process.
The launcher includes unchanged official entries from the native cache. Per-thread catalog paths do not reload native metadata and are rejected
when different from the startup catalog. This is an explicit tradeoff of the
selected `model_catalog_json` configuration, not an additive catalog mechanism.

## Boundaries in upstream code

`src/patch/transforms.ts` locates five semantic boundaries with Acorn:

- `AppServerRequestClient.sendRequest`
- `AppServerRequestClient.prewarmThreadStart`
- The conversation manager's `setDefaultModelConfig`
- The model visibility predicate, identified by destructured property names
  and its access-program check rather than a minified function name; static
  catalog visibility shortcuts are disabled for unregistered entries so native
  official-model availability checks still run
- The model/effort selector, restoring explicitly registered third-party options
  after native account-level filtering while retaining native model behavior

MagicString wraps the existing function bodies; scheduling, errors, and tracing
remain in the original implementation. Imports reference our own isolated ES
module directory, avoiding modifications to hashed upstream import graphs.

`src/patch/discovery.ts` enumerates packed renderer JavaScript under `webview/`.
It uses code markers to skip unrelated assets and collects structural edits from
all candidate modules. Every patch point must be unique globally. There are no
version adapters or source fingerprint allowlists. Modules may be renamed,
combined, nested in subdirectories, or split; imports are resolved relative to
the discovered paths. Desktop version metadata is diagnostic only.

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

## Windows copy preparation

`src/patch/prepare-windows.ts` handles `prepare-windows --app EXE --output DIR`.
The selected EXE's directory supplies the entire application payload. A source
inventory and structural patch/PE checks precede output creation. A newly created
private output directory reserves ownership; an existing output is never reused.
Copying preserves native files and internal links, remapping absolute internal
links into the copy. Escaping links and credential files are rejected. Source
identity/size/time inventories are compared around copying and patching to detect
updates. Read-only source ASARs become writable only in the copy.

The staged archive uses the same atomic writer and independent ASAR reader.
`windows-executable.ts` bounds-checks PE section/resource offsets and locates the
Electron V1 fuse wire plus `INTEGRITY/ELECTRONASAR` resource. It replaces only an
existing fixed-size ASAR header digest, preserving fuses and all unrelated EXE
bytes. A changed signed executable is explicitly reported as having invalidated
its publisher signature. Both prepared artifacts are checked before renaming the
private staging directory to `DIR/app`; exceptions remove the owned output.

Preparation never starts an app or changes MSIX registration. Returned paths are
explicit launch targets. No authentication, configuration or history migration
is part of preparing a copy. `check` still reports archive compatibility only;
its additive target information does not make a write probe.

## State

Config discovery is cached for 30 seconds per client. Observed thread-provider
metadata is bounded to 512 entries; missing custom-thread identity is resolved
with `thread/read`. The runtime does not persist its own routing database.

The desktop's own temporary model override holds third-party default selection.
This prevents UI selection from writing a third-party ID into the global OpenAI
configuration used by CLI and background tasks.

Profiles contain provider routing only. Legacy model metadata in normalized
profiles or enabled non-project raw layers produces a migration error. Catalog
entries must match exact model IDs and declare valid scalar default/reasoning
options. No metadata is fabricated or read from arbitrary renderer filesystem
paths. Native catalog reads are marked by request-object identity to avoid
recursion without disabling guards for concurrent UI requests. Pagination is
preserved; repeated/invalid cursors fail closed.

Only selected scalar effort is forwarded to inference. Explicit request effort
takes precedence over in-memory selection, then the native catalog default.
Missing effort on follow-ups/resume is left to native per-chat persistence.
Changing JSON requires restarting the native app-server; refreshing the routing
cache cannot reload its startup catalog.
