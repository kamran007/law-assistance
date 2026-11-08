# AI relay verification (BE-09)

**Date:** 2026-11-05 · **Relay:** the `ANTHROPIC_BASE_URL` configured for development (`api.mwapi.dev/v1`) · **Model:** `claude-opus-5-5` · **Client:** `@ai-sdk/anthropic` 4.0.96 via `packages/providers/src/llm.ts`

This is the input for decision **D10 (AI relay in production)**. Test prompts were invented (place names, a made-up FIR); no user data was sent.

## Results

| Check (implementation plan BE-09) | Result | Evidence |
| :--- | :--- | :--- |
| `claude-opus-5-5` accepted | ✅ | `GET /models` lists it; responses report `model: claude-opus-5-5` |
| Native structured output (`output_config.format`, strict JSON schema) | ✅ | Valid objects for a small schema and for the full FIR extraction schema; the request carried no `tool_choice` / `temperature` / `thinking` |
| Effort forwarded | ⚠️ probably | `effort` is sent in `output_config`; the same FIR took 13.2 s at `low` and 16.5 s at `medium` (one run each). Not provable from outside |
| Server-side refusal fallbacks (`fallbacks: "default"` + beta header) | ⚠️ accepted | No error; whether a refusal is actually rerouted could not be tested without a refusal |
| Prompt caching (cache reads > 0 on repeat) | ✅ | Repeat of a ~15k-token system prompt: `cache_read_input_tokens` 15,363 |
| **Request passed unchanged** | ❌ | See below |
| Added latency | not measured | No direct Anthropic key to compare against. Absolute: ~5.4 s for a tiny structured answer, 13–17 s for a full FIR extraction (~1,500 output tokens) |

## The relay changes requests

1. **It adds a large amount of input.** For the FIR extraction request (system prompt + one invented FIR), Anthropic's token counter (`POST /messages/count_tokens`) gives **1,829** input tokens. The same request through `POST /messages` was billed **28,401 input + 3,542 cache-creation tokens** (≈ 17×; 0.50 relay credits for one extraction). A bare "hi" reports 252 input + 1,861 cached/cache-creation tokens. The relay evidently injects its own content (system prompt or similar) that we cannot see.
2. **It ignores `max_tokens`.** `max_tokens: 10` with "Count from 1 to 60" returned all 60 numbers (85 output tokens, `stop_reason: end_turn`); `max_tokens: 5` on the extraction returned 1,736 output tokens. The Anthropic API never exceeds `max_tokens`.

What this means:
- **Cost:** every call pays for the injected tokens, roughly 15–17× the real prompt for a FIR.
- **Behaviour:** an unknown prompt runs before ours. It did not break extraction or prompt-injection resistance in the test, but it is outside our control and can change without notice.
- **Data:** the relay operator receives every prompt in full. With FIRs that is personal data about complainants, accused persons and witnesses.
- **Our safeguards:** output limits are not enforced by the relay; the client-side timeout (120 s) and schema validation still hold.

## Recommendation

- Keep using the relay **only for development with invented data**. Real user documents must not go through it (D10 stays **blocked**).
- Before pilot: get a direct Anthropic API key (or Claude Platform on AWS, matching the `ap-south-1` hosting plan) and switch by leaving `ANTHROPIC_BASE_URL` empty. No code change is needed.
- Rotate the relay key that was shared in plain text (PRE-01), including the copy pasted into the development chat on 2026-11-05.
- Re-run these checks (the live test `apps/worker/test/extract.live.test.ts` plus the `count_tokens` comparison) against the direct endpoint to get the latency baseline.
