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
