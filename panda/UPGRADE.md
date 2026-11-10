# Panda upgrade — 10 November 2026

Scope: branch `feat/panda-agent-20261110`, only `panda/`, based on `1dc38a7`.
Worker: `panda-personal-agent`. Bot: `@prooo0biv_bot`.
Production has NOT been redeployed by this upgrade session.

## Stages

1. Per-provider UTC daily request/token budgets; bounded fallback; safe diagnostic types.
2. Owner target-chat history (4000 conservative tokens), peer history (6000), isolated context, name/username resolution.
3. Natural-language route action/params/confidence/explanation, low-confidence clarification, owner-only ingestion, send preview.
4. Per-chat style, partial profile patches, prior-state storage, settings undo.
5. Source-grounded fact quotes, D1 background queue, five-message/ten-minute trigger.
6. Conversation state after manual owner messages and confirmed Panda replies; stale revision guard.
7. SiliconFlow chat/background/embeddings, JS cosine within chat, text fallback.
8. Regression and synthetic live verification. Original 68 scenarios retained; two obsolete assertions updated (global budget and generic error wording).

## Before deploying

Run from a checkout of the specified branch. Do not deploy the root project.
Cloudflare authentication must already target the account hosting Panda (`wrangler login`, or environment `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). Never put credential values in files.

```sh
git switch feat/panda-agent-20261110
git pull --ff-only
npm ci --prefix panda
cd panda
npx wrangler secret put SILICONFLOW_API_KEY --name panda-personal-agent
```

Paste the key into Wrangler's interactive prompt. It is NOT installed automatically by committing code.
Existing Panda secrets (`TELEGRAM_BOT_TOKEN`, `OWNER_ID`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `WEBHOOK_SECRET`, `ADMIN_SECRET`) remain unchanged.

The requested embedding default `BAAI/bge-m3` is not available to the tested international key. Set the verified available override before deploying:

```sh
node --input-type=module -e 'import fs from "node:fs";const p="wrangler.jsonc";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.vars.SILICONFLOW_EMBED_MODEL="Qwen/Qwen3-Embedding-0.6B";fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");'
git add wrangler.jsonc
git commit -m 'Panda: select available SiliconFlow embedding model'
git push origin feat/panda-agent-20261110
```

All other environment values are already in `panda/wrangler.jsonc`:

| Variable | Default |
|---|---|
| GROQ_DAILY_TOKENS / GROQ_DAILY_REQUESTS | 200000 / 500 |
| SILICONFLOW_DAILY_TOKENS / SILICONFLOW_DAILY_REQUESTS | 500000 / 1000 |
| OPENROUTER_DAILY_TOKENS / OPENROUTER_DAILY_REQUESTS | 50000 / 100 |
| GROQ_MODEL | openai/gpt-oss-120b |
| SILICONFLOW_BASE_URL | https://api.siliconflow.com/v1 |
| SILICONFLOW_CHAT_MODEL | Qwen/Qwen2.5-7B-Instruct |
| SILICONFLOW_EMBED_MODEL | BAAI/bge-m3 (override above for tested account) |
| OPENROUTER_MODEL | openrouter/free |

Internal budgets do not guarantee provider quotas or free pricing. Completed requests can take usage beyond the token threshold; subsequent requests skip that provider. Request reservation is atomic. Missing usage is conservatively estimated. Legacy aggregate `usage` remains for historical data only.

The deployment script applies every SQL migration in lexical order, idempotently. No manual migration is required when using that script. To apply them separately to the existing Panda database only:

```sh
# Still in panda/
for migration in migrations/*.sql; do
  npx wrangler d1 execute panda-personal-agent-8976655600 --remote --file "$migration" || exit 1
done
npm run check
npm test
cd ..
```

Then run the existing GitHub Actions workflow `.github/workflows/worker-cache.yml` on **feat/panda-agent-20261110**, operation **deploy**. Its UI may retain the old name “Deploy shared week cache”; the branch-specific job is guarded and deploys Panda only. This upgrade does not edit that workflow.

Adding a GitHub secret alone does not expose it to a workflow. The unchanged workflow does not pass SiliconFlow's secret into its runner; the Cloudflare secret installed above is preserved by deploy.mjs (not overwritten with an empty value). If invoking `node panda/deploy.mjs` in an authenticated environment with `SILICONFLOW_API_KEY`, the script also uploads it. Do not print environment variables.

Optional key-specific model check, with the key already in the shell environment:

```sh
curl -s -H "Authorization: Bearer $SILICONFLOW_API_KEY" https://api.siliconflow.com/v1/models
```

## Verification and error findings

- Syntax checks pass.
- 94 unit tests passed (68 original scenarios, including two requirement-updated assertions, plus 26 new scenarios); tests use Miniflare and fictional data.
- Six synthetic live checks passed through SiliconFlow: six requests, zero Telegram API calls, no repeated replies or unnecessary approval cards. The three-turn dialogue produced two replies; silence is allowed by the dialogue contract.
- Live transport in this workspace required Node's `NODE_USE_ENV_PROXY=1`. SiliconFlow validation used `SILICONFLOW_TIMEOUT_MS=20000`; it does not prove the five-second production target. Groq's default request timeout is four seconds, SiliconFlow's ten, OpenRouter's six, with an overall completion deadline. Fallback can take longer than five seconds.
- Historical Groq/OpenRouter HTTP 400/404 causes cannot be established from the old logs: response bodies were not retained. Endpoints and model IDs were checked. Native tool parameters are now confined to Groq; fallback providers use JSON format plus schema instructions and bounded parsing.
- A NEW SiliconFlow 400 was reproduced for `BAAI/bge-m3`: absent from this key's model catalog. `Qwen/Qwen3-Embedding-0.6B` returned HTTP 200 and a 1024-number vector.
- HTTP diagnostic body text is deliberately reduced to safe known error labels, never arbitrary upstream text that could echo keys or personal prompts. Maximum 200 characters.
- Actual automatic conversations with real peers and deployed latency have not been tested by this upgrade session.

## Usage boundaries

In an interlocutor's chat, address commands with “панда”. Unprefixed outgoing text is treated as the owner's manual reply; in the bot DM free text is accepted directly. Ambiguous chat selection asks a question. Bot API does not provide the pre-connection archive. History retains the existing 72-hour window; sourced persistent facts remain until forgotten. Unknown personal commitments still require a draft, but this classification is model-based, not an absolute guarantee.

Automatic extracted facts are exact source quotes, not inferred biographies. Style conflict resolution is model-based; code merges provided fields and preserves other fields. Undo changes settings, not already sent Telegram messages, and does not override a global stop. Do not treat model-reported confidence as proof of understanding.
