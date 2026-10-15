# Design: OpenCode v2 Support Completion

**Status:** Approved for implementation (2026-10-07); revised 2026-10-12 after an audit of the shipped
config side against the live OpenCode 2.0.27 binary and its sources.
**Scope:** finish OpenCode 2.x parity — config emission per provider, session-analytics read path,
model routing. Host-independent except where a live binary is required for verification.

## 1. Goal

Make the OpenCode agent plugin work end-to-end on both OpenCode 1.x and 2.x binaries: emit a config the
installed binary actually accepts for every supported provider, read the session database the installed
binary actually wrote, and classify Responses-API models correctly — so that a v2 run produces the same
session metrics, conversation sync and cost accounting as a v1 run.

## 2. Background

- CodeMie launches the `opencode` binary and injects its configuration at startup: inline JSON via
  `OPENCODE_CONFIG_CONTENT` primary, temp-file via `OPENCODE_CONFIG` fallback above the env size limit.
- OpenCode 1.x reads `provider` (singular) + `npm` + `options`. OpenCode 2.x reads `providers` (plural) +
  `package` + `settings`. The plugin probes `opencode --version` and caches the result with a TTL
  (`resolveOpenCodeConfigVersion()`, `src/agents/plugins/opencode/opencode.plugin.ts:48` — `PATH`
  resolution, shell execution on Windows for `.cmd` shims, 3s timeout, warn-and-fallback to `v1`;
  a successful probe is trusted for 5 minutes, a failed probe's v1 fallback for 30 seconds, so a
   per-invocation CLI process still probes at most once per run while a long-lived process picks up
   an installed/upgraded binary without a restart; `CODEMIE_OPENCODE_CONFIG_VERSION=1|2` overrides)
   and emits the matching shape. Success requires exit `0` and a complete version response, with optional
   OpenCode label / `v` prefix and prerelease/build suffixes; empty, malformed, partial or unrelated stdout
   and nonzero exits use the existing warning + 30-second v1 fallback. Windows executable quoting follows
   the launcher for both resolved and raw metadata paths; POSIX stays shell-free. The v1 path is unchanged
  and must stay byte-identical, since 1.x installations remain the common case.
- `modelID` does not need to be emitted: v2 defaults it to the `models` map key
  (`packages/core/src/provider.ts:380`, `modelID: model.modelID ?? modelID`), and the field is optional.
  Our emission uses deployment IDs as map keys verbatim, so omitting it sends the correct ID by construction.
- Each v2 model entry carries either the default chat package or a per-model `/responses` package override,
  which decides whether the model is sent to `POST /v1/chat/completions` or `POST /v1/responses`. The
  decision is taken once, in `isResponsesApiModel()` (`opencode-dynamic-models.ts:74`), when the fetched
  catalogue is converted; the v2 emission then splits the converted configs
  (`opencode.plugin.ts:399-400`) and copies the per-model `package` override (`:445-451`).
- Responses-API-only families (gpt-5.2, gpt-5.x-codex, gpt-5.4/5.5/5.6, gpt-6) are recognised by name
  patterns (`opencode-dynamic-models.ts:37-50`); everything else goes to chat-completions. Whenever the
  proxy adds a new Responses-only family the catalogue must recognise it, otherwise the model is emitted
  without the override and fails at request time with no warning at config-generation time.
- **Session analytics are DB-backed, and the DB layout is version-specific.** OpenCode 1.x wrote
  `session` / `message` / `part` tables; 2.x renamed and rebuilt them to `session_v2` / `session_message`
  (migration `ALTER TABLE session RENAME TO session_v2`) and nested message parts inside the message row.
  The reader must handle both layouts (§7). Turn-level telemetry is delivered by hooks, but the hooks
  write `transcript_path` pointing at this database — with the reader returning nothing, every downstream
  metric consumer is empty while appearing healthy.
- **Per-provider v2 behaviour differs and is not uniform.** The proxy provider is fully expressible in v2.
  Ollama in v2 has no built-in AI provider package; its inventory comes from a bundled discovery plugin
  (§4). Bedrock has a real v2 provider package (§4) but was being emitted in the v1 shape.

## 3. High-level approach

**Extend in place with version branching, in three groups:**

1. Session-storage read path: detect the database layout at runtime and read both layouts through one
   typed mapping (§7). This is the blocking item — without it a v2 run reports no metrics at all.
2. Config emission: a native v2 block per provider, and an explicit provider allowlist on every v2 branch
   (§4).
3. Routing and coverage: harden the single point where endpoint routing is decided (§6) and cover the v2
   shapes (§5).

This is selected because the v1 path stays byte-identical (no fork, no flag day); delivery (inline vs.
file) stays orthogonal to schema; provider differences stay isolated per branch — adding a future provider
means adding one block; and runtime database detection is strictly more robust than keying off the
   installed binary's version, because the database on disk may have been written by a different version
   than the binary currently on `PATH` (and `codemie opencode-metrics` runs standalone).

**V2 isolation classification (narrow A3 scope).** Add `--standalone` only where the v2 command accepts
it, preserving the existing isolation of `run`, `mini`, `api`, `models`, `stats`, `reload` and the
supported leaves under `auth`/`session` (not the bare groups). Pass `debug`, `mcp`, `plugin`, `upgrade/update`, `uninstall`, `serve`, `service`, `acp` and
`pair` through without that automatic flag. Root TUI isolation requires no positional command or an
existing directory argument; unknown words are not guessed as TUI. Skip leading root option values
when identifying commands, respect explicit server/standalone flags before `--`, and insert automatic
isolation before that separator. A directory named like a command can be passed explicitly after `--`.
Keep the v1 gate, legacy `ownedSubcommands`, task/effort/model mappings and native argument validation
unchanged. Private capability lists are not a new CLI ownership/feature integration.

## 4. Config emission

`injectV2Config()` (`opencode.plugin.ts:96`) delivers every v2 config through the unified strategy
(inline primary, temp-file fallback). Branches:

- **SSO/proxy (default, `:437-475`):** native `providers.codemie-proxy` block with the full model
  catalogue, `share: 'disabled'`, `model` as `provider/model`.
- **Ollama (direct, `:494-512`):** endpoint-only native block, `package` = the chat package, no `models`
  map. Inventory is *not* served by that package: v2 ships no `ollama` provider in
  `packages/ai/src/providers/`, and the openai-compatible package exposes only `configure` / `model` /
  `routes`. Inventory comes from the bundled discovery plugin `packages/core/src/plugin/provider/ollama.ts`,
  which reads the declared `providers.ollama.settings.baseURL`, strips a `/v1` or `/api` suffix,
  enumerates `/api/tags`, enriches each entry with `/api/show`, and keeps only models whose capabilities
  include `completion` (`ollama.ts:75-78`, each request bounded to 1s, `local.ts:168-184`). Its transform
  is a no-op when zero models load (`local.ts:61-62`), so a model-less provider stays model-less — which is
  why the allowlist below matters more here than anywhere else.
- **Bedrock (direct):** a native v2 block, replacing the v1 fall-through. v2 registers
  `@opencode/ai/providers/amazon-bedrock` as a built-in provider whose settings accept
  `apiKey`, `auth`, `baseURL`, `credentials`, `profile`, `region`
  (`packages/ai/src/providers/amazon-bedrock.ts:8-35`). Region falls back through the AWS environment
  (`AWS_REGION`, `AWS_DEFAULT_REGION`, then `us-east-1`) and credentials fall back to the AWS default chain
  when omitted (`amazon-bedrock.ts:16-22,46`), so the env the Bedrock provider plugin already sets keeps
  working and only `region` needs to be declared. The selected model is also emitted as an explicit
  `models` entry so the `model:` reference resolves independently of the bundled catalogue (which v2
  does ship for Bedrock — verified: 187 entries under `amazon-bedrock/*` alongside the declared one).

**Reasoning effort on v2.** v2 removed `--variant` from `run`, so the central cli-flag injection
would fail every effort run with "Unrecognized flag" (exit 1). Effort therefore travels through
the config instead of argv:
- **SSO/proxy:** the branch declares per-model `variants` entries (body overlays only) on
  reasoning-capable models — `reasoning_effort` for chat-completions, `reasoning.effort` for
  Responses. Both openai-compatible packages forward `body` into the request payload
  (`http.body`), and v2 deep-merges variant overlays (`withVariant` in
  `packages/core/src/model-resolver.ts`), so the proxy receives standard params it already
  speaks. Variants are emitted only when effort is requested; otherwise the config stays
  byte-identical to the no-effort shape (inline env budget is 32 KiB). The selected
  reference is suffixed (`codemie-proxy/<id>#<level>`) **and** passed on the argv as
  `-m <ref>` by `enrichArgs` (via a second env handoff): `run` resolves the variant only
  from the CLI `--model` reference (parseRunModel → switchModel → withVariant) and ignores
  the `#variant` suffix on the config `model:` key at session init — verified live, config
  suffix alone sends no effort params. A `shouldApply` gate (consulted by `BaseAgentAdapter`,
  vetoed by the plugin after the version probe) skips `--variant` injection on v2 — quietly
  when the effort was honored (marker env `CODEMIE_OPENCODE_V2_EFFORT_APPLIED`), loudly otherwise.
- **Bedrock: resolved by the effort spike (implemented).** The `amazon-bedrock` package's
  Converse route is driven through `additionalModelRequestFields`, and the branch now mirrors
  OpenCode's own `bedrockConverse` variant protocol (`packages/core/src/variant.ts:421-453`)
  verbatim: Claude 4.6+ gets `output_config.effort` next to adaptive thinking, Claude
  3.7 / 4.0–4.5 get `settings.thinking.budgetTokens` (the one typed setting the package
  accepts, `amazon-bedrock.ts:33`). Variant ids are the canonical levels, so the same
  `#<level>` suffix plus `-m <ref>` argv handoff the proxy branch uses resolves here.
  Two CodeMie-side prerequisites were part of the spike: reasoning cannot be gated on
  `modelConfig.reasoning` (a Bedrock id starts with `us.anthropic.`, so `getModelConfig()`
  misses the `claude` family prefix and reports `reasoning: false`), and the generic
  `{ context: 128000, output: 4096 }` fallback clamped every budget to 2048 through
  `fitThinkingBudget`, so the branch resolves each model's real limits from its Claude
  version, taken from the AWS Bedrock model cards (not the Claude API pages, which differ
  for Sonnet 4.6): 200k / 64k for Sonnet 4, Sonnet 4.5, Opus 4.5, Haiku 4.5; 200k / 32k for
  Opus 4.1; 1M / 64k for Sonnet 4.6; 1M / 128k for Opus 4.6+ and Sonnet 5 / Opus 5. Sonnet 4
  gets budget-based thinking like the other 4.0–4.5 models. `xhigh` is not supported by
  Sonnet 4.6 on Bedrock (AWS adaptive-thinking table), so it is downgraded to `high` with a
  warning.
  Non-Claude Bedrock models stay out of scope for effort: `toBedrockModelId()` now leaves
  their ids alone instead of mangling them, but OpenCode's generic `reasoningConfig` overlay
  is unverified for them, so effort warns and skips.
- **Ollama: known limitation, do not implement.** The branch is endpoint-only by construction:
  inventory belongs to the bundled discovery plugin (which recreates model entries at runtime)
  and a successful discovery overwrites `provider.settings`, so neither pre-declared `variants`
  nor provider-level body overlays survive. Effort on ollama-v2 warns and skips by design.

**Provider allowlist.** v1 pins `enabled_providers: ['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock']`
(`:564`). v2 understands the key (`packages/core/src/config/normalize.ts:388`) and originally received none
of it, which both polluted the model picker with unrelated catalogue models and hid routing failures — an
unresolvable `ollama/<id>` was silently replaced by another provider's default instead of failing. Every v2
branch therefore sets `enabled_providers` to exactly the single provider that branch declares
(`codemie-proxy` `:459` / `ollama` `:498` / `amazon-bedrock` `:532`). This excludes other providers, but
does not forbid fallback to another available model within the selected provider. A provider with no
available models yields an explicit "no model is available" error; a missing root default alone does not.

**Missing proxy model policy (F5-6, agreed 2026-10-14).** In the v2 proxy branch, a selected model absent
from the emitted catalogue aborts before OpenCode is spawned, with `ConfigurationError` and guidance to
select an available model. This applies equally to explicit CLI/env choices and persisted profile defaults:
no automatic replacement is allowed. The wrapper does not declare a synthetic model from
`getModelConfig()` just to make the reference resolve. On rejection it stops the launch's incremental
sync timer, and the adapter stops its already-started proxy while preserving the configuration error.
It does not discover a transcript for a child that never started. Existing catalogue-fetch fallback to
static configs is retained; membership there does not certify backend availability. This correction leaves
v1 emission, full-selector/resume semantics (F5-5), and the direct Ollama/Bedrock branches unchanged.

The error includes the profile name when available and source-specific recovery using the existing
`CODEMIE_MODEL_SOURCE` marker. CLI users must correct `--model`; env users must update or unset
`CODEMIE_MODEL`, which overrides the profile. A saved default is changed through `codemie setup` →
**Update an existing profile** → the named profile → select and save an available model. The message
distinguishes that persistent change from a one-run `--profile <profile-name> --model <model-id>` override,
requires bare catalogue IDs while F5-5 is open, and states that `codemie models list` uses only the active
profile. Missing provenance is reported as unknown instead of guessed as a profile default.

Proxy v2 model entries include `{name, capabilities, limit?, package?}` alongside existing cost/variants
metadata — no `modelID`, correct by construction per §2. In both chat-completions and Responses loops,
`capabilities.tools` preserves `tool_call` (including `false`), and `capabilities.input`/`output` preserve
`modalities.input`/`output`. Explicit metadata overrides OpenCode's custom-model tools/image defaults;
it does not add a capability inference policy or change the catalogue, v1 model shape, reasoning,
limits, pricing or direct-provider branches (F5-7).

**Shared Bedrock ID default (history-split decision, 2026-10-15).** Keep `us.` when no region is supplied,
preserving the existing v1 and built-in agent geography policy. Explicit regions and already-qualified
IDs/ARNs remain authoritative, including an explicitly selected `global.` profile. The necessary ID and
suffix corrections do not imply switching the shared default to global routing.

## 5. File layout

```
src/agents/plugins/opencode/
├── opencode.plugin.ts                 # probe (63), injectV2Config (111), effort helpers (206-232), shouldApply gate (323), v2 branches (503-648), v1 block (650-727)
├── opencode-model-configs.ts          # getModelConfig() fallback (808) — no endpoint decision here
├── opencode-dynamic-models.ts         # the single routing decision (isResponsesApiModel, 74) + name patterns (37-50)
├── opencode.sqlite-reader.ts          # database layout detection (242) + v1 and v2 readers
├── opencode.session.ts                 # discovery callers (discoverSessions 477, parseSessionFromDb 194)
└── __tests__/
    ├── opencode-config-version.test.ts   # probe override / cache / fallback cases
    ├── opencode-v2-emission.test.ts      # v2 emission shape per provider branch
    ├── opencode-v2-effort.test.ts        # v2 effort variants/suffix/marker + shouldApply gate
    └── opencode-sqlite-reader.test.ts    # both database layouts + failure visibility
src/agents/plugins/codemie-code-hooks/inject-hooks.ts   # cleanup hooks: call the v2 cleanup too
.ai-run/guides/integration/external-integrations.md     # v2 schema, storage layout, override
docs/COMMANDS.md                       # user-facing v2 behaviour and its real limitations
```

## 6. Model classification

| Model ID shape | Endpoint | Decided by | Notes |
|---|---|---|---|
| `gpt-5-2-*`, `gpt-5.2-*`, `gpt-5.*-codex-*`, `gpt-5-*-codex-*`, `gpt-5.4-*`, `gpt-5-4-*`, `gpt-5.5-*`, `gpt-5-5-*`, `gpt-5[.-]6-*`, `gpt-6*` (not `gpt-60*`-style) | `POST /v1/responses` (per-model `package` override) | Name patterns (`opencode-dynamic-models.ts:37-50`) | GPT-6 coverage (luna, sol, astra, 6.1-sol) in place with static configs + tests |
| Unknown future Responses-only ID (misses the patterns) | `POST /v1/responses` | Family heuristic in `isResponsesApiModel()`: a `gpt-<major>` ID whose single-digit major is at or beyond the lowest explicitly listed major (6) is treated as Responses-only | Closes the silent misroute: such an ID is otherwise emitted without the `/responses` override and fails at request time |
| Everything else (`gpt-4*`, `o1/o3/o4*`, `claude-*`, `gemini-*`, …) | `POST /v1/chat/completions` | Default (no override) | Unchanged |

The heuristic must live in `isResponsesApiModel()`, not in the `getModelConfig()` fallback: routing is decided
when the fetched catalogue is converted (`opencode-dynamic-models.ts:136`), and only the converted configs
feed the chat/Responses split (`opencode.plugin.ts:399-400`). A flag set on a fallback config never reaches
that decision — the fallback result is consumed solely for `providerOptions` and the `model:` reference
(`opencode.plugin.ts:394-396,460,499,533,608`). A flag that no routing code reads is worse than no flag: it
implies a guarantee that does not exist.

One implementation constraint: `opencode-dynamic-models.ts` already imports
`opencode-model-configs.ts`, so the check must not import it back. Placing the heuristic inside
`opencode-dynamic-models.ts` is naturally cycle-free. Plugin code must never be imported from `src/cli`.

## 7. Session storage schema

The reader opens the user's live database read-only, so layout detection must be cheap and cached. Detect
from `sqlite_master` once per database path, and key the cache on that path.

| Concern | OpenCode 1.x | OpenCode 2.x |
|---|---|---|
| Sessions | `session` | `session_v2` |
| Messages | `message` (`data.role`) | `session_message` (`type` column) |
| Parts | `part` table, one row per part | no table; nested in the message row |
| Ordering | implicit, sorted in JS | `seq` column available |

- `session_v2` is a superset of the columns the reader selects (`id`, `project_id`, `slug`, `directory`,
   `title`, `version`, `time_created`, `time_updated`), so the session query is a table-name substitution;
   it additionally carries per-session `cost` / `tokens_*` / `time_idle` columns that a later change may use.
- **Windows paths (F5-4):** for detected v2 layout on Windows, normalize cwd separators to `/` before
  binding the SQL predicate, matching upstream `database/path.ts` storage representation. Returned v2
  drive/UNC directory paths convert back to native `\`, matching upstream `fromDriver`, so existing
  filesystem consumers such as the timer's `safeRealpath` receive comparable paths. Leave v1/file
  representations, POSIX paths and empty legacy directories unchanged; no case folding, broader
  discovery, source-ID fallback or database write is introduced. The gate uses layout, not binary version.
- `session_message` rows are `(id, session_id, type, seq, time_created, time_updated, data)`. Role comes from
  `type`, not from `data.role`, and only `user` and `assistant` rows are messages — the type column also
  carries `idle`, `system`, `shell`, `synthetic`, `agent-switched` and `model-switched` rows, which must be
  skipped.
- Message field mapping (verified against a live 2.0.27 database):
  - `type='user'` → `data` carries `{time:{created}, text, files, agents[]}`; there is no per-message model
    or single agent, so `model` stays unset rather than fabricated.
  - `type='assistant'` → `data` carries `{time:{created, streamed, completed}, agent, model:{id, providerID,
    variant}, content[], finish, rawFinish, cost, tokens}`; the v1 flat `providerID` / `modelID` map from
    `model.providerID` / `model.id`, and `completed` maps onto the existing `time.completed`.
- Parts are read from `data.content[]` of the same rows rather than a second query: entries are
  `{type:'text', text}` or `{type:'tool', id, name, executed, state:{status, input, content[], metadata}}`.
  A tool entry therefore needs translation onto `OpenCodeToolPart` — `callID` from `id`, `tool` from `name`,
  and the rendered output assembled from `state.content[].text` into `state.output` (v2 returns a content
  list, not a single output string). v2 stores no per-part id, so parts get a stable synthetic id derived
   from message id and content index; `messageID` / `sessionID` / `type` are filled in as before.
- **File operations (F5-8):** the existing metrics processor also accepts v2 `metadata.files[]`
  (`file`, `patch`, `additions`, `deletions`, `status`) for `edit` and `patch/apply_patch`. Map file statuses
  `added/deleted/modified` to the existing `write/delete/edit` operations and `file` to `path`. Prefer
  supplied nonnegative integer counts, preserving zero; use the existing diff counter only as the
  fallback for absent/invalid counts. Legacy patch paths/types and edit `filediff/diff` retain precedence.
  Keep raw reader metadata, the delta/API shape, record IDs, dedup and all other tool behavior unchanged;
  do not backfill historical deltas as part of this correction.
- **Visibility.** A missing table must never be silent again. Detection removes the "no such table" class
  entirely; whatever fails after that is a real fault and is reported, not absorbed. Both query backends now
  return a reason instead of a bare `null` (`opencode.sqlite-reader.ts:143` native, `:179,189` CLI), and
  `queryDb` raises `AnalyticsSourceError` rather than returning an empty list (`:221-230`), so the sqlite3
  fallback is still tried but a failure on both paths cannot masquerade as "no rows".
  `discoverSessions` already logs `warn` and falls back to file-based discovery when discovery throws
  (`opencode.session.ts:506-510`) — that path is now reachable instead of being fed an empty array that looks
  like "no sessions".
- Read signatures stay unchanged (`readSessionsFromDb`, `readMessagesFromDb`,
  `readAllPartsForSessionFromDb`); the only caller is `opencode.session.ts` (`:202,212,215,485`), so
  layout branching stays internal to the reader.

## 8. Telemetry hooks

Turn-level telemetry (`UserPromptSubmit` / `Stop` → `codemie hook`) is delivered by the injected hooks
plugin. v1 packaging is a single `.ts` file referenced by URL; v2 requires a plugin directory, rejects
single-file targets (`packages/core/src/config/plugin/source.ts:151-153`), no longer consumes
`OPENCODE_HOOKS` at all, and no longer runs v1 plugin implementations — the port uses `Plugin.define`,
`ctx.session.hook("prompt")`, `ctx.event.subscribe({signal})`, `ctx.tool.hook(...)` and
`ctx.session.hook("compaction")`, delivered through `plugins: [...]` as a directory URL
(`opencode.plugin.ts:427` builds it, `:474,511,550` register it). The v1 single-file payload is created only
by the v1 block that consumes it (`:612`). The `OPENCODE_HOOKS` environment variable is still set by the CLI
(`:367`) because the ported payload reads it itself.

Both payloads' fire-and-forget delivery (`execCommandAsync`) no longer assumes `sh` exists. On POSIX it
spawns with `shell: true` (`/bin/sh -c`). On Windows it prefers a POSIX `sh` found on PATH (Git for Windows,
MSYS; bash-syntax hook commands keep working) and otherwise falls back to `shell: true`, i.e. the
`%ComSpec%` shell. The old hardcoded `sh -c` hit ENOENT on a stock Windows and silently dropped
UserPromptSubmit/Stop telemetry (second-audit F5); the sync `execSync` path always used the platform
default. The child is detached only on POSIX: `detached: true` with `shell: true` leaves `cmd.exe` hung on
Windows (verified live), and `unref()` plus ignored stdout/stderr already keep it from holding the host.

With §7 fixed, these hooks make metrics land; without §7 they fire into a database the reader cannot read.
The two are one feature, not two.

Cleanup hygiene in the same area: the v2 payload's cleanup function is exported (`inject-hooks.ts:15`) but
was never called, `onSessionEnd` cleaned up only the v1 payload, and the v1 payload file was materialised on
every run past the base-URL check even when only the v2 directory was registered. Both cleanups now run in the
`onSessionEnd` finally block (`opencode.plugin.ts:729-732`), and the v1 file URL is created only when the v1
shape is emitted (`:612`).

## 9. Error handling

| Scenario | Behavior |
|---|---|
| Version probe fails (missing binary, hung `--version`, nonzero exit, empty/malformed version response) | Log warning with the reason without raw stdout/stderr, fall back to the v1 schema — startup never blocks on detection; the fallback is cached only for the 30s failure TTL, so the probe is retried soon instead of being recorded as a five-minute successful v1 probe |
| Selected v2 proxy model is absent from the emitted catalogue (CLI/env or profile default) | Throw `ConfigurationError` before spawning OpenCode; stop the launch timer and proxy, do not substitute a model or discover another session's transcript |
| `CODEMIE_OPENCODE_CONFIG_VERSION=1\|2` is set | Explicit override wins over probe result and cache |
| Ollama endpoint unreachable, or no model reports the `completion` capability | The v2 discovery plugin contributes zero models, the provider stays model-less, and the allowlist turns that into an explicit "no model is available for session" error instead of a silent switch to another provider |
| Bedrock on a v2 binary | Native v2 block with `region` from the AWS environment; credentials resolve through the AWS default chain. If the provider package rejects the emitted settings, the failure surfaces from OpenCode, not as a misconfiguration CodeMie hid |
| Unknown model ID misses the Responses patterns | The family heuristic in `isResponsesApiModel()` routes it to Responses instead of emitting it for chat-completions |
| Database layout is neither the 1.x nor the 2.x shape | Log `warn` naming the detected tables, return no sessions, and let `discoverSessions` fall back to file-based discovery — never a silent empty result |
| A query fails on a detected layout | Log `warn` with the database error; do not present it as "no sessions" |
| Emitted config exceeds the env size limit | Temp-file fallback via `OPENCODE_CONFIG` (same rule for v1 and v2) |
| `--reasoning-effort` on v2 proxy with a reasoning-capable model | Honored via `#variant` suffix + body-overlay variants; `--variant` injection skipped quietly |
| `--reasoning-effort` on v2 with a non-reasoning model, ollama, bedrock, or no base URL | Warn (log + console) and continue without effort — never inject `--variant`, which the v2 binary rejects |
| v2 hooks plugin fails to load | v1 path unaffected; v2 run keeps coarse metrics only (documented degradation, not silent) |

## 10. Out of scope

- Extracting shared GPT-matching logic into `src/utils/`: the duplication between the OpenCode catalogue
  and the VS Code connector is intentional (`src/cli` must not import from an agent plugin). The new
  heuristic stays inside `opencode-dynamic-models.ts`.
- Cost / token columns from `session_v2` (`cost`, `tokens_*`): available for a later change, not read now —
  the metric payload shape is out of scope.
- Any `openwiki/` edits (generated, refreshes on schedule).
- Refactoring the hooks payload beyond what §8 lists.
- Reasoning effort on ollama-v2 (known limitation, see §4): inventory and settings belong to the
  v2 discovery plugin, so pre-declared variants cannot survive — effort warns and skips there by
  design. Reasoning effort on non-Claude Bedrock models is likewise out of scope (see §4).
- Committing local-only review notes.

## 11. Verification

1. Gates: `typecheck`, `lint`, `build` clean; existing OpenCode specs green.
2. Session storage, against the live 2.x database at the standard XDG location:
   - table list contains `session_v2` / `session_message` and not `session` / `message` / `part`;
   - `readSessionsFromDb()` returns rows (not `[]`), `readMessagesFromDb()` returns user and assistant
     messages for a known session id, `readAllPartsForSessionFromDb()` returns text and tool parts;
   - a session whose id comes from a live hook run yields non-empty metrics (tokens, turns) — this is the
     end-to-end proof that the analytics gap is closed.
3. Config emission, against the live 2.x binary with a stubbed upstream:
   - proxy branch: catalogue listed, `gpt-6*` sent to `/responses`, `claude-*` to `/chat/completions`;
   - ollama branch with a real Ollama endpoint: models discovered and selectable; with the endpoint down,
     an explicit error instead of a silent switch to another provider;
   - bedrock branch: the session starts and the model resolves.
4. v1 regression: force `CODEMIE_OPENCODE_CONFIG_VERSION=1` and repeat a prompt — the v1 config is
   byte-identical to `origin/main` and turn metrics land as before; run the v1 reader path against a
   1.x-shaped database fixture.
5. Full CI (`npm run ci`) green before merge, per `.ai-run/guides/quality-gates.md`.

## 12. References

- `src/agents/plugins/opencode/opencode.plugin.ts` — probe (63), `injectV2Config` (111),
  effort helpers (206-232), `shouldApply` gate (323), v2 proxy branch (503-579), v2 ollama branch
  (581-611), bedrock branch (613-648), v1 block (650-727), allowlist (546)
- `src/agents/core/types.ts` — `ReasoningEffortConfig.shouldApply` (95)
- `src/agents/core/BaseAgentAdapter.ts` — gate consultation in the injection path (655-670)
- `src/agents/plugins/opencode/opencode.sqlite-reader.ts` — `session` query (212), `message` query (257),
  `part` query (327), swallowed failures (89-91, 130-145)
- `src/agents/plugins/opencode/opencode.session.ts` — `parseSessionFromDb` (194), `discoverSessions` (477),
  discovery failure fallback (506-510)
- `src/agents/plugins/opencode/opencode-dynamic-models.ts` — name patterns (37-50),
  `isResponsesApiModel` (74, called at 136), flag emission (158)
- `src/agents/plugins/opencode/opencode-model-configs.ts` — `getModelConfig()` fallback (808); it decides no
  endpoint, and deliberately carries no responses flag
- `src/agents/plugins/opencode/opencode-message-types.ts` — message and part shapes to map onto
- `src/agents/plugins/codemie-code-hooks/inject-hooks.ts` — v2 payload cleanup (15)
- `src/cli/commands/proxy/connectors/vscode-models.ts` — Responses-only rule precedent (`isResponsesOnlyGpt`)
  and the architecture constraint (no `src/cli` ← plugin imports)
- OpenCode 2.0.27 sources (reference copy, never edited): `packages/core/src/config/plugin/source.ts`
  (single-file drop), `packages/core/src/config/normalize.ts` (`enabled_providers`, v1 field migration),
  `packages/core/src/plugin/provider/ollama.ts` + `local.ts` (inventory discovery),
  `packages/ai/src/providers/amazon-bedrock.ts` (provider settings), `packages/core/src/provider.ts`
  (modelID default, built-in registry), the `session` → `session_v2` migration
- `.ai-run/guides/integration/external-integrations.md`, `docs/COMMANDS.md` — documentation surface
