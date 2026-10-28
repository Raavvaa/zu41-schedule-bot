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

Follow-up on 2026-10-28: two regressions also failed on the first PR #6 commit
(`62fda7440f13ad8428b15e2ccd6032f1055c2c2b`). A normal attributed sentence about a
past addition was rejected as a false receipt, and the last-operation context
contained no original actions. The follow-up permits bounded past-tense owner
attribution while still rejecting first-person/unverified receipts. It exposes
original actions, net entries and prior balances in major units for the last
committed operation. If its draft has expired, original actions/before are null;
the model cannot reconstruct them from wallet deltas. Questions about past
operations bypass the current-balance shortcut and cannot create money proposals.

Additional review follow-up (2026-10-28, against `9dca6031b`): twelve targeted
tests were run before the patch; eight failed and four already passed. The
failures reproduced opinion requests reaching money tools, a purchase shortcut
ignoring an opinion request, unlisted planned purchases reaching tools, event
totals being treated as corrections, over-restricted owner attribution, a lost
gift source when its amount is repeated, ambiguous numeric gift references,
and a bare allocation number being accepted at the smaller scale.

The external reviews were not applied verbatim:

- Opinion requests and wishes restrict all money tools and the existing purchase
  shortcut. The model still writes the response. An opinion does **not** force a
  question about recording. An explicit instruction to record an actual event
  can accompany an opinion question.
- A planned purchase is not tied to a list of product names. This stays a
  heuristic boundary, not a claim of complete natural-language understanding.
- `statedAmounts` keeps explicit units. The patch does not authorize both RUB
  and thousands just because another number used thousands. A bare allocation
  such as the second number in "18 thousand, 9 to the house" requires one scale
  question. Its immediate short answer is bound to that request for 15 minutes;
  a standalone unit after the topic/turn changes cannot replay the request.
- Event totals may be proposed, while explicit balance/correction statements
  remain protected even alongside an event or an imperative. The review's broad
  `explicitRecord` exemption from correction was not adopted.
- Owner attribution is clause-local; simply having "you" somewhere in a reply
  does not exempt a new bot receipt. Passive receipts and explicit bot subjects
  remain rejected. This linguistic check is still imperfect and gets one repair.
- A direct reference to one recent gift retains its source when the amount is
  repeated. A different amount or ambiguous source cannot silently create a new
  record. A newly narrated income is not attached to a prior gift just because
  it contains a demonstrative.

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

Executed locally on 2026-10-28: **90/90 tests pass** (53 existing, 37 conversation
tests), syntax checks pass,
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
It also covers acknowledgment after confirmation, last-operation lookup,
split-income versus net-delta semantics, balance corrections, unavailable old
drafts, and read-only questions that mention an earlier amount.
The fourteen new tests cover the reviewed opinion/wish, source-binding,
correction and attribution defects, both interpretations of a bare allocation,
explicit units, and one-time resolution of a scale question.
All fixtures and identifiers are synthetic; external APIs are mocked.

A manual real-model smoke script is prepared:

```sh
node accountant/test/conversation-live.mjs
```

For the current opinion/wish/event-total regression, choose this alternative
suite **instead of** adding a second quota-consuming run:

```sh
node accountant/test/conversation-live.mjs --opinion
```

It needs the existing secret in the execution environment, uses disposable D1
and fake Telegram, caps Groq HTTP calls at eight, and stops on the first provider
error. Logs contain aggregate counts/timings, not dialog text or credentials.
It is not attached to a push workflow. This environment has no Groq credential,
so real-model understanding/latency and Telegram delivery are not validated.

The live opinion suite checks absence of drafts and preservation of the intended
event amount, not the quality of advice. Review its conversation separately with
the owner after an approved release. No live transcript is logged by the harness.

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
