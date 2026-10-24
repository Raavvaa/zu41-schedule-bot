# Conversation versus accounting repair

Base: `feat/brat-accountant` at `6890c7a3bdf4cb08685f29bf573c155522075d03`.
Scope: `accountant/` only. This is a narrow repair, not the full PR #5 feature set.

## Reproduced defects

Two new integration regressions fail against the unchanged base, using synthetic
data and mocked Groq on a temporary D1 database:

- A reply recalling a conversational gift amount is replaced with the numeric
  fallback because the amount is absent from the ledger/current user message.
- A wrong model tool call creates a proposal even though the current message
  explicitly says not to record the gift.

These results identify defects in this source revision. They do not prove which
revision is currently running in Cloudflare.

## Changes

- Conversational amounts, prices and plans are no longer checked as balances.
  Asserted current balances still use ledger checks; balance cards use D1.
- Explicit no-record instructions and recall questions restrict money tools,
  without replacing ordinary conversational replies with an accounting template.
  This also covers the pre-model purchase/balance shortcut.
- Failed receipt/balance claims get at most one repair by the model. The normal
  path keeps `tool_choice=auto`; there is no required-financial-tool retry.
- A later explicit instruction can refer to one recent unrecorded gift, within
  15 minutes and the retained conversation window. It must yield one matching
  income, shown for confirmation. The draft stores its source, and an applied
  source cannot be added again. Ambiguous/old references need clarification.
- Search results are labelled conversation data. RUB/AZN totals are computed
  separately; unknown wallet totals remain unknown.
- Model availability errors are short and contain no irrelevant accounting
  commands. Provider limits themselves are unchanged.

No new dependencies, automatic posting, schema migration, schedule-bot changes,
production database queries, deployment, or real Telegram messages.

## Validation and limits

Executed locally: **70/70 tests pass** (53 existing, 17 new), syntax checks pass,
and `git diff --check` passes. Real Groq calls: **0**. Real Telegram calls: **0**.
The two targeted regressions also ran against the unchanged base and both failed;
the same scenarios pass with this patch. This is mocked integration evidence,
not a claim of real-model accuracy or deployment success.

Run from `accountant/`:

```sh
npm ci --ignore-scripts
npm test
npm run check
node --check src/conversation.mjs
node --check test/conversation-live.mjs
```

The new integration suite covers the full gift conversation, both reply paths,
wrong model tools, post-conversation recording, confirmation replay, double-leg
income, withdrawal confusion, stale/ambiguous references, unrelated expenses,
memory search, conversation/support/wishes, false receipts and 429 responses.
All fixtures and identifiers are synthetic; external APIs are mocked.

A manual real-model smoke script is prepared:

```sh
node accountant/test/conversation-live.mjs
```

It needs the existing secret in the execution environment, uses disposable D1
and fake Telegram, caps Groq HTTP calls at eight, and stops on the first provider
error. Logs contain aggregate counts/timings, not dialog text or credentials.
It is not attached to a push workflow. This environment has no Groq credential,
so real-model understanding/latency and Telegram delivery are not validated.

## Release review

The feature branch's `worker-cache.yml` deploys the schedule project: do not run
it. The current `deploy/brat-accountant` workflow checks out the base SHA above
and runs the older, much longer live harness. Neither workflow was changed or run.

Before any deployment, obtain owner approval for the reviewed diff. A subsequent
release must pin the approved source SHA, use the bounded manual smoke gate,
verify the current live version, and review the existing deployment script's
additional provider calls/owner checks. No live success is inferred from unit
tests. The existing shared Groq quota still applies.

Rollback is the previous verified deployment SHA. There are no schema changes;
the additional draft JSON property is backwards compatible.
