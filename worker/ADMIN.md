# Private owner administration

`/admin` is a manually typed private-chat command. It is not registered in Telegram's public command list and is not added to reply or inline keyboards.

Access requires ADMIN_ENABLED=true and BOTH authenticated Telegram sender ID and private chat ID to match the existing OWNER_CHAT_ID secret. The webhook secret is verified first; group chats, spoofed sender/chat combinations and callbacks cannot grant the role. An absent or malformed owner secret denies access. There are no database-managed admin roles or commands to add other administrators. The ID and tokens are not committed or printed.

Commands:
- `/admin` — help.
- `/admin status` — active version, delivery mode, Cron/queue heartbeat, Telegram pause and internal queue budget.
- `/admin stats` — saved/active subscriptions, opt-ins, incoming events and confirmed outgoing delivery counts. Incoming counts include button presses. History is limited by journal retention.
- `/admin groups` — aggregate subscriptions by group, without personal identifiers.
- `/admin queue` — pending/retry/in-flight/failed/uncertain job counts.
- `/admin errors` — delivery outcomes and processing errors in the last 24 hours.
- `/admin source` — today's cache status and successful-check age.
- `/admin refresh` — refresh the owner's saved group's real schedule, at most once per minute. No arbitrary URL or target user is accepted.

Reports are sent through the same durable fast-reply outbox as other responses. Admin commands do not alter subscriptions or interrupt the current settings dialog. No mass messaging, user impersonation, secret display or blind resend of uncertain jobs is implemented.

Validation includes another user's access denial for each tested admin command, missing/malformed configuration, group and spoofed identity rejection, absence of admin buttons, preserved preferences/dialog state and source-refresh throttling. Deployment uses current Actions Secrets, verifies exact source SHA and sends one `/admin` response only to the existing owner; on failure it disables ADMIN_ENABLED while retaining public access and fast replies.
