# Брат-бухгалтер

Private Telegram accounting assistant, independently deployed as Cloudflare Worker
`brat-sabunchi-accountant` with its own D1 database. The existing schedule bot,
webhook, subscriptions and deployments are not modified. Code lives in this
repository only to reuse its authorized deployment Secrets.

- Owner-only private chat; ID from Secret, never source or model context.
- Two wallets, RUB/AZN separated, exact integer minor units and explicit opening
  balances. No starting financial figures or exchange rate assumptions are seeded.
- Natural Russian/slang via Groq `openai/gpt-oss-20b`, maximum 60 calls/day.
- Model proposes only. Every ledger write needs a private Telegram confirmation;
  capital withdrawals have a separate explicit warning. Wishes never debit money.
- Atomic D1 batch, revision guard, expiring drafts, immutable transaction/entry
  journal, undo via reversal. Concurrent confirmations cannot spend twice.
- Balance/history/commands remain usable without Groq. Memory retains eight recent
  messages in context, removes conversation history after 30 days; /память stores
  an explicit note, /забыть clears conversational context, not accounting records.
- Optional proactive support Monday/Wednesday/Saturday at 19:00 Moscow, one/day,
  15-minute delivery window, no night or catch-up messages. /settings, /тишина,
  /общайся, /время allow changes. Religion toggle; no generated scriptural quotes.
- Durable update inbox/outbox and minute Cron recovery, per-chat paced sending,
  429 retry_after pause, 403 disables unsolicited contact, uncertain sends are
  quarantined rather than blindly resent. Exactly-once Telegram delivery is not
  claimed: an API acceptance followed by a network break is inherently ambiguous.

Free-plan deployment adds only this Worker/database. It never calls billing or
upgrades. Secret: SABUNCHI_BOT_TOKEN; existing current GROQ_API_KEY,
CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_CHAT_ID, ADMIN_SECRET.
Deployment derives distinct webhook/ops secrets internally and installs runtime
secrets through stdin. No real user ID, account text, balances or tokens belong
in commits, artifacts or logs. Financial messages and minimal conversation context
are sent to Groq to interpret the owner's language; Telegram ID and tokens are not.

Run: `npm ci`, `npm test`, `npm run check` in accountant. Deployment workflow is
manual, pinned to a reviewed commit and runs local workerd/D1 tests before rollout.
Live probe checks Groq, webhook and actual sendMessage result only for the owner.
If Telegram refuses first contact, the owner must open the bot and press Start.
A fresh Cron Trigger may take several minutes to propagate; last_cron is stored.

This assistant records cash and supports personal budgeting. It cannot transfer,
block access to actual cash, verify bank balances, guarantee an investment outcome,
or replace professional tax/legal advice. Initial goal/current cash must be confirmed
inside Telegram; the code includes illustrative command examples only.


## Voice input (v1.2)
Owner-only Telegram voice notes: OGG/Opus, maximum 90 seconds / 2 MiB, 20 recognition attempts per Moscow date. Groq whisper-large-v3-turbo receives uploaded audio bytes, never a Telegram token-bearing download URL. Audio is not persisted in D1 or logs. The transcript expires after 15 minutes; accepted text follows existing conversation retention.

Preview requires explicit “Разобрать” before interpretation. A monetary proposal still requires a separate ledger confirmation. Transcript acceptance and its durable queued update are committed in one D1 batch. Repeated clicks/updates cannot process the same transcript twice. Silence, low-confidence metadata, bad file paths, large streams and 429 are handled without guessing amounts. Replies are text; outgoing voice conversation is not part of this release.

### Reviewed references / capability patterns
- https://github.com/groq/groq-api-cookbook — official examples, speech recognition and structured application logic.
- https://github.com/simonw/llm-groq-whisper — independent CLI integration; reviewed as an example, not installed in the Worker.
- https://console.groq.com/docs/echokit — voice assistant integration; full hardware/voice stack is unnecessary for Telegram voice notes.
- https://console.groq.com/docs/speech-to-text — multipart upload, multilingual Whisper, verbose confidence metadata.

No external skill gets credentials or ledger write permissions. “Skills” here are bounded application capabilities: read journal, propose validated entry, confirm entry, interpret speech. Confirmation and exact arithmetic remain deterministic code.
