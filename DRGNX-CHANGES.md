# drgnx changes

What the drgnx fork adds on top of the upstream release it is based on. Upstream's own files, its changelogs
included, stay as upstream released them.

## `@moonshot-ai/acp-server`

### Minor Changes

- `_drgnx/panel` extension (version 1), advertised in `agentCapabilities._meta["_drgnx/panel"]` only to a client that sent `clientCapabilities._meta["_drgnx/panel"] = {version: 1}`. Features: `context` (a `_drgnx/context` notification after each turn: `used` / `size` as `usage_update` reports them, `parts` estimated from the engine's token counting), `compact-preview` (a `_drgnx/compact/preview` request answered from the compaction strategy, no model call) and `before-tool` (a `_drgnx/before_tool` request from the tool executor's before-execute event; a deny, a failed request or an unreadable answer denies the tool, an allow only continues). `drop` and `pin` are not advertised yet. Permission requests now carry the tool `kind`, and `FetchURL` maps to `fetch`.
