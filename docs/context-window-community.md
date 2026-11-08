# Community context-window findings

Research date: **2026-11-08**. This reviews public reports, maintainer comments,
merged PR metadata, and provider documentation. Community success reports are
not independent reproductions; this project's local measurements are in
[validation.md](validation.md#context-window-probe-2026-11-08).

## Closely matching reports

| Source                                                       | Report and evidence                                                                                                                                                                                                                                                                                                                                                                        | Status when checked                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [Codex #14456](https://github.com/openai/codex/issues/14456) | CLI 0.114.0 ignores context-window and compaction settings inside inline profiles. A [maintainer confirmed](https://github.com/openai/codex/issues/14456#issuecomment-4047203785) that those keys were unsupported in profiles. The reporter offered a config-parser fix branch.                                                                                                           | Closed; closure is not evidence that the proposed fix shipped.                                          |
| [Codex #57670](https://github.com/openai/codex/issues/57670) | CLI 0.165.0, privately hosted GLM-5.3: a requested 999999-token window becomes approximately 258K after the first prompt. The reporter says other harnesses verified the endpoint's 1M support.                                                                                                                                                                                            | Open, no comments or documented resolution.                                                             |
| [Codex #58052](https://github.com/openai/codex/issues/58052) | CLI/app-server 0.165.0: unknown third-party models hit the 272000 fallback maximum despite a 1048576 override. Requests provider/model metadata without replacing the dynamic OpenAI catalog.                                                                                                                                                                                              | Open, no comments. Closest architectural match to this project.                                         |
| [Codex #32349](https://github.com/openai/codex/issues/32349) | MiniMax metadata is not found despite inference working. A [user reports success](https://github.com/openai/codex/issues/32349#issuecomment-4958284567) after moving `model_catalog_json` out of the provider table to the top level. Another [distinguishes working CLI behavior from unresolved Desktop behavior](https://github.com/openai/codex/issues/32349#issuecomment-5053594589). | Open. The success report establishes metadata recognition, not a measured full-context inference limit. |
| [Codex #47917](https://github.com/openai/codex/issues/47917) | DeepSeek served by different providers retains a stale startup catalog. The reporter uses the minimum provider limit as a conservative workaround. A [follow-up reports](https://github.com/openai/codex/issues/47917#issuecomment-5900353063) that restarting the persistent daemon applies catalog edits when merely relaunching Desktop does not.                                       | Open. A catalog lifecycle issue, distinct from missing metadata.                                        |

## Documented solution paths

### Local native model catalog

[Munito's Codex integration guide](https://docs.munito.ai/agents/codex#model-metadata)
documents supplying GLM-5.3-Flash metadata through `model_catalog_json`, setting
both `context_window` and `max_context_window` to 1048576 and disabling request
features its endpoint does not support. It explicitly says the file replaces
the built-in catalog. This is a documented external-model configuration route,
not a recommendation to copy another model's capabilities blindly.

[Fluence's provider documentation](https://inference.fluence.cloud/docs#context-windows-in-coding-tools)
likewise directs Codex users to set context and compaction values per entry in
the local catalog and avoid an unwanted global window override. Its suggested
headroom is specific to its routing estimates, not a general Codex requirement.

The capability is upstream functionality: [PR #12101](https://github.com/openai/codex/pull/12101)
merged on 2026-02-19. Profile-level catalog selection followed in
[PR #12410](https://github.com/openai/codex/pull/12410), merged on 2026-02-21.
In [#12100](https://github.com/openai/codex/issues/12100#issuecomment-3953839597),
a user provides an LM Studio/gpt-oss example with a profile-specific catalog;
another [explains](https://github.com/openai/codex/issues/12100#issuecomment-3990768156)
that launching without that profile preserves ordinary cloud-model use.
This concerns process startup with a selected CLI profile, not dynamically
selecting profiles for different threads in one running Desktop app-server.

Do not confuse `model_catalog_json` with editing `models_cache.json` in place:
users in [#12100](https://github.com/openai/codex/issues/12100#issuecomment-3948430670)
report that cache edits are overwritten. Nor is a minimal two-field JSON object
necessarily a valid catalog entry: [#54494](https://github.com/openai/codex/issues/54494)
requests sparse entries because the current parser expects a complete descriptor.
That issue remains open; its linked prototype was not compiled or tested against
the cited upstream base, according to its author.

### Explicit CLI overrides when the native maximum already permits them

In [Azure report #27743](https://github.com/openai/codex/issues/27743#issuecomment-4699156734),
the reporter says CLI `-c` overrides restored a 1M window. Crucially, that model's
catalog already had `max_context_window = 1000000`. This does not demonstrate a
way around the 272000 maximum for unknown external models.

[PR #18382](https://github.com/openai/codex/pull/18382), merged on 2026-04-18,
explicitly introduced clamping configured windows to the catalog maximum.
Setting only a larger `model_auto_compact_token_limit` is not a substitute for
correct model metadata.

### Provider-served native catalogs

[PR #46561](https://github.com/openai/codex/pull/46561), merged on 2026-09-19,
added `model_providers.<id>.model_catalog_url`. A provider can serve its own
Codex-native model metadata separately from inference. The endpoint must provide
the native catalog format; an ordinary OpenAI-compatible `/v1/models` response
is not enough. The native provider authentication and discovery gates apply.

[PR #49135](https://github.com/openai/codex/pull/49135), merged on 2026-09-29,
made explicit provider catalogs authoritative and model matching exact. This
is useful for providers that publish native metadata. It is not evidence that
this project's shared, OpenAI-started app-server resolves a different catalog
for every custom thread. [PR #46917](https://github.com/openai/codex/pull/46917)
describes the shared catalog as retaining the startup provider, while #58052
still requests concurrent provider/model metadata support.

## Implications for this project

This section records the pre-migration assessment. The subsequent implementation
uses an explicitly selected static combined catalog, documents the loss of dynamic
catalog refresh, and decorates registered native entries in place. See the
[native catalog migration validation](validation.md#native-catalog-migration-2026-11-08).

Changing Codex source is not universally necessary to use a large-window external
model. Local catalogs and provider-served catalogs are native configuration
paths. The narrower unsolved requirement here is preserving dynamic native
OpenAI models while giving each explicitly registered external model accurate
native metadata inside the same running app-server.

The pre-migration runtime deliberately rejected a model ID that occurred in both
its profile registry and the native model list. A catalog containing the same
registered external model therefore needs integration work, not just a new
config line. Replacing the native catalog with a static combined snapshot would
also require maintaining its metadata and no longer preserve dynamic updates.

Before considering a backend fork, validate a separate disposable startup using
an accurate native catalog and the existing localhost fixture. Then test whether
the target backend has a supported way to scope that metadata to a custom
provider/thread while leaving native OpenAI discovery intact. Keep this
investigation separate from live credentials, installed archives, and existing
thread state. No community workaround was installed during this research.
