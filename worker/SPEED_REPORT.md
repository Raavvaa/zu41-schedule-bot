# Fast replies, 14 October 2026

## Confirmed cause

The original webhook passed one fixed timestamp to deliveryTick. Multiple replies to the same chat acquired the one-second chat cooldown at that same timestamp; subsequent parts were changed to retry with a due time one second later. Only the minute dispatcher would then pick them up. A lane-wide lock could also prevent immediate delivery to an unrelated chat in the same lane. The queue already used batch size one / timeout one: a claimed five-second batch wait was not the primary cause.

## Implementation

Interactive replies use a separate per-user drain, durable D1 outbox and existing atomic job claim. They check chat cooldown before claiming and pace up to two messages per invocation. Only contended/remaining replies enqueue a bounded continuation; the original Cron is the recovery path. A separate in-flight chat lock prevents overlapping slow Telegram sends. Telegram 429 respects retry_after; an ambiguous outcome remains uncertain without blind retry. Eight-second Telegram timeout, eighteen-second drain budget, twenty-five-second drain lease. Validated callback acknowledgement runs alongside the response when an execution context is available. Public /health exposes source SHA and feature mode. FAST_REPLY=false restores the original delivery path; owner mode supports a controlled canary.

No student settings, webhook destination, registration capacity or existing scheduled notification rules are changed. No paid resources or new databases/queues are created. An additive index improves ordered per-user outbox queries.

## Local verification

28 Node/workerd tests passed, including persistent D1 restart, two independent users, private chat/callback validation, subgroup selection, date boundaries, source failures, cancellation/move, 429/403, uncertain delivery, duplicate and concurrent webhook/Cron/fast delivery, ordered four-part replies and 50-recipient scheduled burst. Four-part simulated pacing: 3300 ms, maximum 27 D1 queries per drain. Full fast menu webhook: 24 queries; full week: 39. Maximum scheduled test invocation: 40. Bundle dry run: 119.65 KiB, gzip 42.73 KiB.

Simulated timing excludes real network/queue delays and is not a production p95. Existing immediate-send sent_at values were written using the webhook arrival time; historical zero-latency rows understate actual Telegram round trips. The deploy script reports these as lower bounds, not a valid end-to-end before/after benchmark.

## Deployment procedure

Run scripts/speed-up-worker.mjs through the dedicated pinned GitHub workflow with existing Actions Secrets. It verifies live source access, public mode, legacy sender disabled, webhook destination, owner subscription, historical aggregate latency and existing database. It applies the additive index, deploys owner canary, sends the owner's real current weekly schedule through the webhook/outbox, verifies Telegram message IDs, replays the update to check deduplication and compares subscription preferences before/after. Only after success does it deploy FAST_REPLY=true and verify the owner's menu, webhook and scheduler heartbeats. Failures after deployment disable the fast path without stopping the public bot or re-enabling the old sender. No raw private service errors or personal data are logged.

College-wide throughput and production CPU percentiles have not been measured. Existing minute-based scheduled delivery remains bounded to three jobs per lane; this change targets interactive reply latency.


## Verified production results

Deployed source SHA: `6e738684ab060bf93d12372e2fbfe7da5d2466e6`.

- [Owner canary and public rollout](https://github.com/Raavvaa/zu41-schedule-bot/actions/runs/38531601038): success on 14 October 2026, 07:56 UTC. Cloudflare fetched the real catalogue (33 groups) and confirmed four lessons for example group 63 on 14 October. Public health reports version 2.1.0, the exact SHA, active mode and FAST_REPLY=true.
- Owner's actual weekly schedule: one part, Telegram message 313 confirmed, D1 creation to Telegram acknowledgement 893 ms, webhook HTTP acknowledgement 236 ms. This particular schedule fit in one message; it does not prove live multipart throughput.
- Owner menu after public activation: Telegram message 314 confirmed, delivery 471 ms, webhook acknowledgement 229 ms. Exact webhook replay left delivery IDs and jobs unchanged in both tests.
- [Three rapid real owner requests](https://github.com/Raavvaa/zu41-schedule-bot/actions/runs/38532004508): success. Menu / today / tomorrow returned Telegram message IDs 315, 316, 317, with measured delivery times 2091, 3260, 9361 ms. HTTP acknowledgements: 437, 519, 433 ms. All three confirmed within 10.8 seconds as observed from the Actions runner. Queue contention still adds seconds; this is not a subsecond delivery guarantee.
- Subscription preference hashes matched before and after both live checks. Webhook destination unchanged, pending Telegram updates zero at rollout completion, Cron and consumer heartbeats fresh, old morning Actions sender still disabled.
- Historical aggregate timing query returned 143 replies with zero recorded latency because the old immediate sender used arrival timestamps. It cannot support a numerical production speedup factor or reliable old p50/p95 comparison. New fast sends write the time after Telegram responds. No representative production p95 has been measured.
- 28 Worker tests and 21 legacy Python tests passed; CI also verified the deploy bundle. No payment, new service or new secret was required. Secrets and personal identifiers were withheld from public logs; only owner-test Telegram message IDs and aggregate timing/health were printed.
