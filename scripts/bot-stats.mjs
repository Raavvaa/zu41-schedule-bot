// Read-only aggregates. No Telegram IDs, raw messages or credentials in logs.
const e=process.env;
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot')throw new Error('Wrong repository');
async function cf(path,body){
 let r,j;
 try{r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+e.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});j=await r.json();}catch{throw new Error('Cloudflare query failed; private details withheld');}
 if(!r.ok||j.success!==true)throw new Error('Cloudflare rejected read-only query: HTTP '+r.status);
 return j.result;
}
const db=(await cf('/d1/database')).find(x=>x.name==='mkgik-schedule-bot-v2');
if(!db)throw new Error('Bot database missing');
const sql=async(query,params=[])=>{const r=await cf('/d1/database/'+db.uuid+'/query',{sql:query,params});return r[0].results;};
const since=Date.parse('2026-10-12T11:38:00Z');
const publicSince=Date.parse('2026-10-12T21:32:12Z');
const out={checked_at:new Date().toISOString(),webhook_started:'2026-10-12T11:38:00Z',public_started:'2026-10-12T21:32:12Z'};
out.people=await sql(`SELECT count(*) AS saved_subscriptions,coalesce(sum(blocked=0),0) AS active_subscriptions,coalesce(sum(blocked=1),0) AS blocked,coalesce(sum(morning_enabled=1 AND blocked=0),0) AS morning_enabled,coalesce(sum(reminders_enabled=1 AND blocked=0),0) AS reminders_enabled,count(DISTINCT group_id) AS groups FROM users`);
out.incoming=await sql(`SELECT count(*) AS updates,count(DISTINCT user_id) AS distinct_people,coalesce(sum(state='done'),0) AS done,coalesce(sum(state='failed'),0) AS failed,coalesce(sum(state IN ('pending','processing')),0) AS waiting,min(created_at) AS first_at,max(created_at) AS last_at FROM updates WHERE created_at>=?`,[since]);
out.public_incoming=await sql(`SELECT count(*) AS updates,count(DISTINCT user_id) AS distinct_people FROM updates WHERE created_at>=?`,[publicSince]);
out.incoming_daily=await sql(`SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch','+3 hours') AS date_moscow,count(*) AS updates,count(DISTINCT user_id) AS people FROM updates WHERE created_at>=? GROUP BY date_moscow ORDER BY date_moscow`,[since]);
out.deliveries=await sql(`SELECT kind,state,count(*) AS n FROM jobs WHERE created_at>=? GROUP BY kind,state ORDER BY kind,state`,[since]);
out.deliveries_daily=await sql(`SELECT strftime('%Y-%m-%d',sent_at/1000,'unixepoch','+3 hours') AS date_moscow,kind,count(*) AS n FROM jobs WHERE state='sent' AND sent_at>=? GROUP BY date_moscow,kind ORDER BY date_moscow,kind`,[since]);
out.delivery_attempts=await sql(`SELECT outcome,count(*) AS n FROM attempts WHERE at>=? GROUP BY outcome`,[since]);
out.dialog_states=await sql(`SELECT state,count(*) AS n FROM dialogs GROUP BY state`);
out.retained_incoming=await sql(`SELECT count(*) AS nonempty_payloads FROM updates WHERE payload<>'{}' AND created_at>=?`,[since]);
// Categories of bot responses, not literal historical student messages.
out.response_categories=await sql(`SELECT CASE
 WHEN payload LIKE '%Привет!%' THEN 'welcome'
 WHEN payload LIKE '%Выбери группу%' OR payload LIKE '%Совпадений нет%' THEN 'group_search_or_list'
 WHEN payload LIKE '%Какая подгруппа%' THEN 'subgroup_selection'
 WHEN payload LIKE '%%Когда присылать расписание?%' THEN 'morning_setup'
 WHEN payload LIKE '%Напоминать перед каждой парой?%' THEN 'reminder_setup'
 WHEN payload LIKE '%Сейчас идёт:%' OR payload LIKE '%Следующая пара:%' OR payload LIKE '%На сегодня следующих пар%' THEN 'current_or_next'
 WHEN payload LIKE '%📅 %' THEN 'schedule_or_schedule_warning'
 WHEN payload LIKE '%Группа:%' THEN 'settings_or_confirmation'
 WHEN payload LIKE '%Твои настройки сохранены%' THEN 'existing_user_menu'
 WHEN payload LIKE '%⚠️ Не удалось выполнить запрос%' THEN 'request_error'
 ELSE 'other_screen' END AS category,count(*) AS n
 FROM jobs WHERE kind='reply' AND state='sent' AND created_at>=? AND payload IS NOT NULL GROUP BY category ORDER BY n DESC`,[since]);
out.source_states=await sql('SELECT status,count(*) AS n FROM schedules GROUP BY status');
out.runtime=await sql("SELECT name,value FROM meta WHERE name IN ('last_cron','last_consumer')");
out.queue_budget=await sql('SELECT date,used FROM queue_budgets ORDER BY date DESC LIMIT 3');
console.log('BOT_STATS '+JSON.stringify(out));
