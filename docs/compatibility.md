# Compatibility

The patch attempts **every Desktop version by default**. There is no app-version
allowlist, hardcoded renderer filename, or predefined upstream asset hash check.
The app's version is recorded in the patch manifest for diagnostics only.

It enumerates packed JavaScript modules under `webview/`, uses inexpensive code
markers to identify candidates, then locates five patch points with Acorn. Each
point must occur exactly once across the entire candidate set. The points may
move between files, combine into one module, or split across modules. Injected
runtime imports are relative to each discovered module's directory.

Both declared functions and function expressions are matched structurally. A
bundler may inline the model visibility predicate inside the effort selector;
the selector wrapper uses separate boundary insertions so both targets remain
independently checked without replacing or hiding the nested predicate.

Matching code structure is the compatibility criterion. Missing, ambiguous,
malformed, or overlapping targets fail before the archive is modified. Changes
to the native request contracts may still require runtime updates; unrestricted
version eligibility is not evidence that untested code layouts or native APIs
work. No check is bypassed by pretending an unknown version is a tested version.

## Windows Store/MSIX

A user report on Windows 11 x64 with tool **0.6.1**, MSIX package
`OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0` and archive app version
**26.1106.51428** passed `check` but failed at `mkdtemp` under
`WindowsApps\...\app\resources`, including from an elevated shell. This is
user-reported structural compatibility, not a locally validated Windows runtime.
The package version and archive `package.json` version are separate metadata.

Windows protects installed package files; creating a sibling temporary archive
or replacing the installed ASAR is not a supported deployment workflow. Moving
temporary files to `%TEMP%` would not grant replacement permission and could
cross volumes. See [Microsoft's package installation documentation](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes#installation).

`prepare-windows --app EXE --output NEW_DIRECTORY` instead copies the complete
application directory into a private output, patches the copy, synchronizes the
EXE's existing ASAR header digest, verifies it, and publishes `NEW_DIRECTORY/app`.
It reads the selected application's payload only, does not register/unregister
packages, and does not read credential files or migrate user data. Source updates
during preparation, escaping links, existing outputs, and ambiguous patch/PE
layouts fail with cleanup. Standard WindowsApps volumes are rejected for direct
patching; permission failures elsewhere report the writable-copy alternative.

Windows PE32/PE32+ resource layouts and Electron V1 fuse wires are recognized
structurally, without a Desktop-version or asset-hash allowlist. When integrity
is enabled, the existing `INTEGRITY` / `ELECTRONASAR` resource must agree with the source ASAR header. Only
its 64-byte SHA-256 value changes; executable sections, other resources and fuse
states are retained. An enabled fuse with missing or ambiguous metadata fails.
With the integrity fuse disabled, the EXE is copied byte-for-byte, retaining its
signature even if it contains inactive integrity metadata.
See [Electron's integrity format](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
and [Microsoft's PE format](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format).

Updating that digest invalidates any existing Authenticode signature in the copy;
the tool reports it rather than disabling integrity or claiming the publisher
signed the modified file. Signed-code enforcement may block the copy. It is not
registered with an MSIX identity, and package-dependent functionality, native
login, updates and graphical operation are **not certified** by preparation.
Use the returned EXE path, fully exit the original app first, and use a fresh
copy for each update. The original Store shortcut still launches the original.

Local verification covers synthetic Windows executables and application trees,
including source preservation, read-only source directories, native/unpacked
files, links, output isolation, digest synchronization and failure cleanup. The
native release-package smoke driver also exercises this command on all six
platform targets. These tests do not launch a real Windows Desktop app.

## Validated Desktop archives

| Desktop version | Platform     | Evidence                                                                                                   |
| --------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| 26.1007.71326   | Linux x86_64 | Actual structural patch and catalog-aware method tests                                                     |
| 26.1021.22027   | Linux x86_64 | Actual structural patch/method tests; native catalog window, compaction and resume/fork smoke              |
| 26.1103.32239   | Linux x86_64 | Actual archive patch, integrity/idempotence checks and method tests with nested anonymous picker functions |

The 26.1103.32239 validation uses a disposable official archive and exercises
native visibility/effort filtering, external model routing, prewarming and default
selection without launching Electron or authenticating. Interactive inference,
tool calls and restart/resume have not been revalidated for this version.

`nix/upstream.json` pins the official download used by CI. It is an integration
test fixture, not runtime compatibility data. Consumers independently select
their Desktop version and pin its download hash as usual for Nix packaging.

Original asset hashes are measured during planning and stored in the manifest.
Installed output hashes and runtime bytes are checked on a repeated invocation
to detect damage or a different patch. These integrity checks do not restrict
which clean upstream versions can be patched.

The configuration's default provider must remain OpenAI. Model metadata now uses
one startup `model_catalog_json`, replacing dynamic discovery with a static native
catalog. Include unchanged official model entries to keep them in the menu.
Profiles map external entries to providers; the renderer decorates these existing
entries without changing unrelated native metadata or authentication.

Per-thread catalog switching is unsupported. The backend must be restarted after
catalog edits, including its persistent daemon where applicable. Native schema
changes may require updating user-authored full model descriptors.

An OpenAI-compatible Chat Completions endpoint alone is insufficient. The provider
must accept Responses API inference, stream events, and the Codex tool schema.
OpenRouter's public catalog identifies the requested model as
`z-ai/glm-5.3-flash`; catalog presence alone is not an inference compatibility test.

This version does not solve desktop account/quota restrictions or guarantee
feature parity for third-party models. It does not modify the closed-source
desktop's account gating. Authentication helpers are executed only by native
Codex when it makes provider requests.
