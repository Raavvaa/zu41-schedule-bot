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

Live deployment and delivery results will be recorded after the workflow completes. College-wide throughput and production CPU percentiles have not been measured. Existing minute-based scheduled delivery remains bounded to three jobs per lane; this change targets interactive reply latency.
