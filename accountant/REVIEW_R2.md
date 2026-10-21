# Review and staged implementation

Base: `6890c7a3bdf4cb08685f29bf573c155522075d03`.
Work branch: `feat/accountant-dialogue-r2-20261021`.
No deployment is authorized by this review. The deployment branch is unchanged.

Read in full: src/brain.mjs, src/index.mjs, src/ledger.mjs, src/voice.mjs,
test/ledger.test.mjs, test/live-dialog.mjs, migrations/0001.sql and both feature
and deployment versions of .github/workflows/worker-cache.yml.
The feature workflow targets the schedule bot. Never dispatch it for accountant.

## Baseline findings

- A1: the broad word filter was already narrowed, but the remaining correction
  gate still rejects income with incidental correction wording. New regression
  covers that case. A3/A4/A5/A8 and explicit-after handling in A9/B1 are already
  present; retained regression tests cover them.
- A2: numeric response replacement remains; same-currency aggregate totals and
  monthly progress are missing from the model snapshot.
- A6: continuation still depends on a recent :clarify memory record.
- A7: notes now append, but remain a bounded flat settings.context field.
- B2: bounded draining/coalescing and contention retry already exist. The
  post-unlock empty-queue race still needs a bounded second check.
- B3: local verb negation is already checked, but false receipts still cause a
  canned response rather than a bounded model repair.
- B4: receipt and reminder interception was narrowed in the base release.
- B5: fixed weekday nudges, one-hour recent-conversation suppression, no mood
  context. Missing capital row dereference is visible in nudge/balanceText.
- propose returns the persisted payload on repeated IDs; draftText already
  computes before/after per affected wallet. Replay tests must remain green.

## Plan and gates

One commit per numbered task; isolated unit suite must pass before the next.
1. Finish P0 interpretation and post-unlock draining without new tables.
2. Computed state, remove numeric prose replacement, repair false receipts,
   bounded required-tool retry, private sanitized diagnostics.
3. Durable dialogue state, closed questions, amendment and amount evidence.
4. Structured facts and daily digest; retain existing memory through migration.
5. Bounded automatic ordinary entries with idempotent undo, safe text approval,
   direct voice interpretation with mandatory monetary approval.
6. Compact persona and bounded general-purpose tools.
7. Contextual opt-out-capable proactive messages.
8. Isolated regression scenarios and honest quality/latency metrics.

Each stage is reversible by reverting its commit before deployment. New schema
must be additive. Deployment rollback uses the previously verified source SHA;
new tables remain harmless to the old code. The owner must approve the final diff
before any deployment or change to deploy/brat-accountant.

## External capability evidence

- Groq local-tool-calling docs document tool_choice=required, including possible
  HTTP 400 if the model does not supply a tool. Support is documented; actual
  behavior still requires the isolated live-model gate.
  https://console.groq.com/docs/tool-use/local-tool-calling
- Groq speech docs describe verbose_json segment avg_logprob, no_speech_prob and
  compression_ratio. These are quality indicators, not a certainty guarantee.
  https://console.groq.com/docs/speech-to-text
- D1 free database size is 500 MB; queries per invocation are limited to 50.
  History retention needs an explicit bounded policy, not assumed unlimited space.
  https://developers.cloudflare.com/d1/platform/limits/

## Stages prepared

1. Bounded recovery and remaining interpretation gate: 55 isolated unit tests.
2. Computed per-currency totals, bounded receipt repair, required-tool fallback,
   metadata-only guard events and private diagnostics: 59 isolated unit tests.
3. Durable closed questions, evidence/date checks, revision-guarded amendments.
   An amendment retains the original transaction; repeated amendment reverses
   the replacement's economic effect, not just the preceding correction delta.
   Reconciliation preserves the purchase as an expense and shows the combined
   balance change in one proposal. Explicit incompatible balances ask one
   discrepancy question. No confirmed financial data was used in tests.

Unit tests mock Groq and Telegram. They do not prove model quality or real
Telegram delivery. Additive schemas are applied only in disposable Miniflare
D1 instances during this review. Deployment remains blocked on owner approval.

4. Facts use independent keys, at most 50 records of 200 characters. Legacy
   context is split into ordered chunks rather than truncated; its old field is
   retained for backward compatibility. Digest creation uses the shared model
   budget, at least 10 new messages, at most one attempt per local day. Dialogue
   retention is bounded to 90 days AND 2000 messages (about 5 MB of text at the
   existing 2500-character ceiling, plus encoding/index overhead). Financial
   history is not purged. This is a conservative policy, not a measured D1 quota
   forecast. The documented free per-database size is 500 MB.

5. Ordinary proven text operations may apply automatically up to the configurable
   default 5000 RUB (/авто 0 disables). Split income and transfer count the larger
   of cash flow and transferred flow, avoiding counting one allocation twice.
   AZN, capital outflow, balance reconciliation, amendments and voice amounts
   always require prior approval. Undo creates one unique reversal. Text approval
   requires a delivered, fresh, revision-matching card without an intervening
   topic. Voice confidence thresholds are application heuristics over documented
   Whisper segment indicators; they are not proof that a number was heard right.
   That is why every voice financial proposal still requires approval.
   Validation: 73 isolated tests, including one-invocation voice processing under
   the conservative 48-request meter and crash recovery of automatic entries.

6. Compact role/principles plus typed tools: facts, historical search, confirmed
   wallet movements and bounded one-shot reminders. Historical turns are JSON
   data, not active chat instructions. Secret-shaped strings and configured
   secrets/owner identifier are redacted before model calls. No arbitrary SQL,
   URL, filesystem or execution tools are exposed. Reminders are limited to
   three active items, at least an hour apart, and expire when over an hour late.
   Validation: 78 isolated tests. These tests prove application guards, not
   immunity of an LLM to every possible prompt injection.

7. Contextual proactive messages: at most one model attempt/day, six-hour silence,
   configured daytime window, opt-out/quiet checks, recent mood suppression and
   SKIP. Mood evidence expires after 36 hours, so one difficult day does not mute
   the bot forever. Monetary progress is appended deterministically. Digest and
   proactive calls share the daily budget. Maintenance observes invocation limits.
   Validation: 79 isolated tests, including skip, fatigue and budget exhaustion.

8. Final local gate: 91 tests pass. All eight migration files were applied to a
   temporary local D1 with Wrangler; a second application found no pending
   migrations. Added date indexes keep current-period reads bounded by the
   requested period. The independent review workflow has only the existing Groq
   credential, fake Telegram transport and disposable D1. It has no deployment
   credentials and does not dispatch worker-cache.yml.

The live harness measures at least 30 actual model-response turns, latency,
model-call count, tokens, repeated replies, clarification turns, scenario success,
voice confirmation steps and retained facts. Its result must be taken from the
workflow log; local mock tests are not a substitute. No latency target is claimed
until measured. Provider rate limits can stop the live gate.
https://console.groq.com/docs/rate-limits

Deployment preparation now uses tracked D1 migrations and requires the dedicated
branch plus ACCOUNTANT_APPROVED_SHA matching the checked-out commit. No remote
migration, deployment, webhook change or production dialogue was performed in
this review. The existing deployment workflow is unchanged. Future release must
first receive the owner's approval of the diff and successful isolated CI.
Production financial probes were removed from the deployment script. Owner-only
nonfinancial delivery checks remain, with message IDs removed from log output.

Rollback: redeploy the previously verified source SHA after approval. Additive
schema remains. Preserve data and never run down migrations. New facts/digest are
ignored by old code; notes entered during a rollback need reconciliation on a
later upgrade. Existing financial history is never deleted by migration.

Final audit additionally reproduced and fixed a missed lock reacquisition after
the final backoff, and a lost acknowledgment when a nonfinancial tool succeeded
but the next model round failed. Amendment cards now show the original and
replacement operation as well as wallet changes, with correction-specific wording.

A final privacy regression reproduced an unredacted digest request. The daily
summary now uses the same secret and owner-identifier redaction as dialogue and
proactive calls, before the model request and before digest persistence.

Two further regression fixtures cover a missing capital-wallet row and undo of
a committed amendment. The latter previously selected an older unrelated
operation; undo now targets the latest unreversed ordinary operation or amendment.

The first completed live run passed 13 scenarios, then rejected the model
allocation shape in the remainder-split scenario. Single-currency income
allocations across both wallets are now canonicalized to one income plus one
transfer, preserving wallet deltas. The complete live gate must be rerun; this
partial run does not establish final model accuracy or latency.

The next live attempt passed six scenarios, then produced two prose responses
instead of a split proposal. Complete event prose now prioritizes the required
financial-tool retry before false-receipt repair; an isolated regression proves
that the retry sends tool_choice=required and excludes respond. Equivalent
capital-first allocations are also normalized without changing wallet deltas.

A live required-tool retry exposed HTTP 400 tool_use_failed on round two.
Recovery previously applied only to round one. One format recovery is now allowed
on any round with budget remaining; required-tool mode stays required and its
repair instruction does not invite prose. A replay test reproduces that sequence.

The subsequent live run reached a provider 429 during format recovery. The review
is not release-ready. The harness reports only rate-limit scope/timing and
response-category metadata to distinguish provider quota from dialogue defects;
it does not log conversation text, financial amounts or provider identifiers.

Diagnostics identified a minute-token limit (retry-after six seconds), not a
daily quota. The model also classified the repeated fixture as an existing record:
the preceding independent slang scenario had already committed the same income.
The remainder scenario now starts from its own synthetic opening ledger. Genuine
post-confirmation acknowledgments remain tested against the committed operation.
The prompt clarifies that equal amounts alone are not webhook deduplication.

Computed goal differences also preserve cent precision; a missing wallet row
keeps the currency total incomplete even if the surviving wallet is initialized.
Both cases were reproduced on the temporary database before the fix.
