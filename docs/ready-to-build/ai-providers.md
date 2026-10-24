# AI Providers: OpenAI, Claude and Gemini, Bring Your Own Key

Status: agreed design, ready to build, not started. Decided 2026-10-23. Code references below checked against the repo on 2026-10-23, when it was filed here from `docs/inbox/`.

Vocabulary as in `docs/AI-SUMMARY.md`: users see **vault**; code and APIs say **namespace**.

## Background

MetaList's AI works only with OpenAI today, on the user's own API key. Users want Claude (Anthropic) and Gemini (Google) too. AI stays optional; MetaList is complete without it.

The planned hosted MetaList runs each user's vault in its own server process. AI there works exactly as in self-hosting: **the user brings their own key**, and calls go from that vault's own process straight to the provider the user chose, under the user's account with that provider. MetaList never supplies, pays for, relays or proxies AI for anyone, including the anonymous demo. So no AI key belonging to MetaList exists anywhere in the code or the deployment.

## What exists today

- **Provider-neutral features, one provider.** Features ask `app/services/ai_setup.py` whether an AI is set up (`describe_ai_setup`) and for a connection (`connect_to_ai`), never for a key. The registry is `AI_PROVIDERS = ("openai",)` (`ai_setup.py:24`); `connect_to_ai` builds an `OpenAIInferenceAdapter` wrapped in `PrivacyGuardedInference` (`ai_setup.py:67–86`).
- **The adapter interface already exists:** `InferenceAdapter` (`app/services/agent/inference.py:105`) with `provider_label`, `inspect_context_window`, `infer_structured`, `stream_text` and `stream_tool_turn`. Tool calling is provider-neutral in `tool_calling.py`.
- **OpenAI specifics:** the Responses API (`openai_inference.py:528`), `store: false` (`openai_inference.py:328`), its own `httpx` client pinned to `OPENAI_API_BASE_URL` with no redirects and `trust_env=False` (`openai_inference.py:98–108`), structured output through Instructor with strict schemas (`strict_structured_outputs.py`).
- **Route models accept only OpenAI:** `provider: Literal["openai"]` and `assert self.provider == "openai"` in `app/api/routes/ai.py` (for example `:123`, `:230`, `:267`). Credential routes are `/openai/credential` (`ai.py:375`, `:392`, `:422`).
- **Key storage:** `app/services/openai_credentials.py`. In an encrypted namespace the key is encrypted with the namespace DEK into `app_settings.openai_api_key_ciphertext` / `_nonce` / `_tag` (`openai_credentials.py:62–66`; migration 5, `app/db/migrations.py:230–232`). In a plaintext namespace it is held only in server session memory (`openai_credentials.py:81`). It is never returned to the browser or included in traces.
- **Cost estimate:** `openai_cost_tracking.py` multiplies API-reported token usage by a price table in code. Served at `GET /api2/ai/openai/cost` and reset at `POST /api2/ai/openai/cost/reset` (`ai.py:646`, `:656`); the chat panel reads it (`app/static/js/modules/ai-chat/ai-chat-api.js:378`).
- **Environment setting:** `METALIST_ENVIRONMENT` is `development` or `production` (`app/startup_environment.py:9–11`).
- **Ollama was removed** (commit `fd09d7fd`); only OpenAI is accepted.

## Design

### 1. Three providers, three adapters

| Provider | Adapter | Notes |
|---|---|---|
| OpenAI | the existing `OpenAIInferenceAdapter` | Move only what's needed behind the registry; zero behavior change. |
| Claude | new `AnthropicInferenceAdapter` on the **native** `anthropic` SDK | Messages API with streaming, tool use with strict input schemas, and prompt caching for the repeated evidence prefix. Not Anthropic's OpenAI-compatibility endpoint: it ignores `strict` on tools, doesn't support prompt caching, and doesn't return thinking. Some Claude models reject forced tool choice; use `auto`. |
| Gemini | new `OpenAICompatibleInferenceAdapter` (Chat Completions), with Gemini as its first configuration row | Gemini's OpenAI-compatible endpoint (`/v1beta/openai/`) supports **Chat Completions only, not the Responses API** used here (Google's compatibility docs; checked 2026-10-23). Later OpenAI-dialect providers reuse this adapter as configuration. If strict structured output or streamed tool calls fall short through that endpoint, use the native `google-genai` SDK instead and record why. |

No LiteLLM or other multi-provider wrapper: three adapters are small, and this is the most privacy-sensitive outbound path in the app.

Normalization the adapters own, proven by the agent eval suite rather than assumed: tool-call formatting, parallel tool calls, how tool results are returned, structured output and its retries (Instructor supports Anthropic; check the strictness guarantees match), length/stop reasons (a length stop must still fail visibly), silence limits and `provider_started`, and usage reporting.

Grok (xAI) is **not planned**; don't add it. Possible later additions, as configuration rows on the OpenAI-compatible adapter: Mistral, OpenRouter.

**Done when:** each of the three providers has run the `evals/` agent cases and the summary/tagging cases, with per-provider pass rates recorded (for example in `evals/RESULTS-*.md`). A provider without recorded pass rates is not offered in the UI. All three are required for the hosted launch.

### 2. Registry, routes and settings

- Extend `AiProvider` and `AI_PROVIDERS` to `openai`, `anthropic`, `gemini`. Each provider registers its label, how to tell it is set up, its base URL, and its adapter factory.
- Route models take any registered provider instead of `Literal["openai"]`; model validation is per provider.
- Provider list, base URLs and model lists are **configuration**, not code (a config file the user can override), because model lists change monthly.
- Provider and model are chosen **per vault**, using the existing chat-panel pickers.
- Provider prompts stay provider-neutral. A per-provider prompt overlay is allowed only where an eval case requires it, with the reason recorded next to it.

### 3. Keys: one encrypted slot per provider, per vault

- Generalize OpenAI's credential store so each provider has its own key slot in the vault, encrypted with the namespace DEK exactly as today. Switching provider never asks for a key again. The storage shape (columns or a small table) is your call; add a migration.
- Same rules for every provider: write-only from the browser, never returned, never in traces, debug or history, and never in any control-plane or account-service request.
- Plaintext namespaces keep today's session-memory-only behavior for every provider.
- Credential routes become per provider (for example `/api2/ai/{provider}/credential`).
- Next to each key field, link to **that provider's own usage and billing page**. That's where users see what they spent.
- **Gemini key field warning:** under Google's terms, free-tier Gemini API traffic may be used to improve Google's products and seen by human reviewers; paid-tier traffic is not (check Google's current terms when writing the text). The field says so and asks for a key from a Google Cloud project with billing enabled. It's a warning, not a check, unless the API exposes the tier.

### 4. Cost estimate: development mode only

- Users never see an AI dollar figure. The estimate is MetaList's price table applied to token counts, can be wrong (for example on interrupted requests), and would need upkeep for three providers.
- Keep it as a developer tool: the cost routes and the chat panel's `$` exist only when `METALIST_ENVIRONMENT=development`. In production the routes return 404 and the UI doesn't render the control. Where shown, it is labeled "estimated".
- Token usage stays recorded uniformly per provider, for the evals and the debug views.

### 5. One outbound boundary

- Every adapter sends through the same boundary as today: `PrivacyGuardedInference`, the whitelist/blacklist and `@password`/`@username` exclusion before serialization, and the canary test that excluded text never appears in an outbound request. No adapter opens its own path to the network outside it.
- Each adapter builds its own HTTP client the way the OpenAI one does: pinned base URL from configuration, no redirects, `trust_env=False`, no SDK retries.
- The agent's tool-permission rules apply identically whichever provider asked.
- The hosted deployment restricts each vault process's outbound network to an allowlist. Provider API hosts come only from the provider configuration, so the allowlist can be generated from it.

### 6. Demo vault

The anonymous demo vault has **AI off by default** and says so in the AI panel: the demo is a tour of MetaList's interface and features, with the AI not turned on. A visitor may paste their own key for any of the three providers. That key is held only in that demo process's memory (the plaintext-namespace session path), never written to the demo template or anywhere else, and is gone when the demo is discarded. The key field says this and suggests a separate, spending-limited key the visitor can revoke afterwards.

Check that the chat panel's hover preview of which notes the AI may see works with no key set, so demo visitors without a key still see the exclusion rules at work.

### 7. No local models

Ollama stays removed. A hosted vault process can't reach a model on the user's own computer, and nothing here brings local models back.

## Invariants

1. The code contains no AI key belonging to MetaList, and no path where one is configured for users.
2. AI keys are per vault, per provider, encrypted with the namespace DEK (session memory only in plaintext namespaces), and never leave the vault's own process except to their provider.
3. Every AI request goes through the one outbound boundary with the exclusion filter and canary, whatever the provider.
4. A provider appears in the UI only after its eval pass rates are recorded.
5. No AI cost figure is shown in production.
6. Provider hosts, base URLs and model lists are configuration.

## Open questions (ask the maintainer)

Found when the note was filed (2026-10-23):

- **The demo vault does not exist yet.** Nothing in `app/` or `docs/` describes an anonymous demo, so Design §6 waits until there is one (it belongs with the hosted plan, `docs/future-plans/hosted-own-copy.md`).
- **Which model each provider is evaluated on.** Agent eval cases are fixed to `gpt-5.6-luna` in code (`evals/agent_models.py:125`, `model: Literal["gpt-5.6-luna"]`), and live evals have so far run on Luna at Low thinking only. Per-provider pass rates (Design §1) need one chosen Claude model and one Gemini model, the eval schema widened to them, and the maintainer's keys for those providers (live runs cost money).
- **Where the provider configuration lives** (Design §2): the file, and how a user overrides it.
- **New dependency:** the native `anthropic` SDK (and `google-genai` if the evals pick it); the supply-chain check covers locked dependencies.
- **Database version:** per-provider key slots change the persistent schema, so they bump `CURRENT_DATABASE_VERSION` (currently 10) with a migration and encryption-audit update, as `AGENTS.md` requires.

From the design:

- **The web tool and the outbound allowlist.** `open_web_pages` (`app/services/agent/agent_tools.py:178`) fetches arbitrary pages from the vault process, which conflicts with a hosted allowlist that admits only known hosts. Options: a separate fetcher with no keys or notes, plus limits on the URLs it accepts; the web tool off in hosted mode; or direct fetching with only private and metadata addresses blocked. Not needed to ship the three providers, but needed before hosted launch.
- **Allowed host, someone else's key.** An allowlist by host doesn't stop code inside the process from calling an allowed provider with a different API key. Worth deciding whether the boundary should check that outbound AI requests carry the vault's own key.
- **Gemini adapter:** OpenAI-compatible Chat Completions or the native SDK (Design §1), decided by the evals.
- **Default model per provider.**
