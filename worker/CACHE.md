# Shared week cache (2.3)

D1 stores the seven published dates returned by the real MS Timetables group page.
With SHARED_CACHE=true, Today/Tomorrow/Week use an existing cached row immediately,
including expired rows. Expired confirmed copies show the last successful check and
create one durable refresh request per group/week. First use of an uncached week
still needs the source. Network errors, malformed HTML and unpublished dates never
become days off or cancellations.

Background priority:
1. Approaching morning/reminder jobs (all subscribed groups, regardless of count).
2. Explicit durable stale-cache requests.
3. Group 63 permanently, plus other catalogue groups with >3 unblocked saved users.

One bounded refresh consumer fetches one group/week; a shared lease and 60-second
source gate prevent per-student duplicate fetches. Published data is normally
rechecked every 15 minutes. Today and tomorrow seed the required weeks, including
Sunday/Monday and year boundaries. No complete catalogue-wide predownload.

Reminders require a successful check at most 60 seconds old. If verification fails,
they wait and expire at lesson start, rather than sending a possibly cancelled class.
Confirmed changes reschedule existing pending jobs in bulk; a due job reloads its
lesson and subgroup and checks the subscription again before Telegram. Existing
sent/uncertain jobs remain untouched. New lessons are planned by existing lanes.

No new paid service, queue or database is required. The existing queue budget,
3-job delivery batches, 50-user pilot ceiling and global Telegram limit remain.
Free-plan resource accounting is bounded per invocation; this is not a claim to
support the entire college. Tests use actual workerd/D1 and captured real HTML.

Deployment: scripts/deploy-shared-cache.mjs applies additive migration 0002,
keeps the existing webhook/admin, verifies live source and cache reads and sends
real Today only to the owner before/after deployment. Logs contain timing samples,
Telegram message receipts and aggregate health, never student IDs or texts.
Rollback: SHARED_CACHE=false; the additional table can remain.
