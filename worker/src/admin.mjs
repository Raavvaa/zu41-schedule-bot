import {one,rows,lock,dayKey,at} from './core.mjs';
import {getSchedule} from './source.mjs';

// The owner is the existing private-chat secret, never a username, command
// argument, callback, saved subscription or user-editable database role.
export function isOwner(env,u){
 const id=String(env.OWNER_CHAT_ID??'').trim();
 return env.ADMIN_ENABLED==='true'&&/^[1-9]\d*$/.test(id)&&Number.isSafeInteger(Number(id))&&
  String(u.user_id)===id&&String(u.chat_id)===id;
}
export const isAdminCommand=text=>/^\/admin(?:@[a-z0-9_]+)?(?:\s|$)/i.test(String(text??''));
const age=(value,now)=>value?Math.max(0,Math.floor((now-Number(value))/1000))+' сек. назад':'пока нет данных';
const help='🔐 Админ-панель\nДоступ: только владелец, только личный чат.\n\n/admin status — состояние и версия\n/admin stats — пользователи и сообщения\n/admin groups — подписки по группам\n/admin queue — очередь уведомлений\n/admin errors — ошибки за 24 часа\n/admin source — свежесть расписаний\n/admin refresh — обновить расписание своей группы\n\nКоманды вводятся вручную. Тексты входящих сообщений после обработки не сохраняются.';
export async function adminResponse(env,u,now){
 // This check precedes EVERY database read and operation in this module.
 if(!isOwner(env,u))return '⛔ Доступ запрещён.';
 const arg=String(u.text).trim().split(/\s+/).slice(1).join(' ').toLowerCase();
 if(!arg||arg==='help')return help;
 if(arg==='status'){
  const values=await rows(env,"SELECT name,value FROM meta WHERE name IN ('last_cron','last_consumer','telegram_pause')");
  const m=Object.fromEntries(values.map(x=>[x.name,x.value]));
  const q=await one(env,'SELECT used FROM queue_budgets WHERE date=?',new Date(now).toISOString().slice(0,10));
  return `🔐 Состояние бота\nРежим: ${env.DELIVERY_ENABLED==='true'?'работает для всех':'закрытая проверка'}\nБыстрые ответы: ${env.FAST_REPLY??'false'}\nВерсия кода: ${(env.SOURCE_SHA??'не указана').slice(0,12)}\nПланировщик: ${age(m.last_cron,now)}\nОчередь: ${age(m.last_consumer,now)}\nПауза Telegram: ${Number(m.telegram_pause)>now?'ещё '+Math.ceil((Number(m.telegram_pause)-now)/1000)+' сек.':'нет'}\nЗаданий передано в Cloudflare Queue сегодня (UTC): ${q?.used??0}/2800\nЭто внутренний бюджет заданий, не число сообщений Telegram.`;
 }
 if(arg==='stats'){
  const users=await one(env,'SELECT count(*) AS total,coalesce(sum(blocked=0),0) AS active,coalesce(sum(blocked=1),0) AS blocked,coalesce(sum(morning_enabled=1 AND blocked=0),0) AS morning,coalesce(sum(reminders_enabled=1 AND blocked=0),0) AS reminders FROM users');
  const incoming=await one(env,'SELECT count(*) AS n,count(DISTINCT user_id) AS people FROM updates WHERE created_at>=?',now-7*86400000);
  const sent=await one(env,"SELECT count(*) AS n FROM jobs WHERE state='sent' AND sent_at>=?",at(dayKey(now),'00:00'));
  const delivered=await rows(env,"SELECT kind,count(*) AS n FROM jobs WHERE state='sent' AND sent_at>=? GROUP BY kind",now-7*86400000);
  const labels={reply:'Ответы',morning:'Утренние',reminder:'Напоминания',part:'Дополнительные части'};
  return `🔐 Статистика\nСохранённых подписок: ${users.total}\nАктивных (бот не заблокирован): ${users.active}\nЗаблокировали бота: ${users.blocked}\nУтренняя рассылка: ${users.morning}\nНапоминания: ${users.reminders}\n\nЗа последние 7 дней по сохранённому журналу:\nОбратившихся пользователей: ${incoming.people}\nВходящих событий: ${incoming.n} (текст и нажатия кнопок)\n${delivered.map(x=>(labels[x.kind]??x.kind)+': '+x.n).join('\n')||'Отправок пока нет'}\nСегодня отправлено (МСК): ${sent.n}\nПодтверждение отправки — ответ Telegram API; прочтение не отслеживается.`;
 }
 if(arg==='groups'){
  const groups=await rows(env,'SELECT group_name,count(*) AS n FROM users WHERE blocked=0 GROUP BY group_id,group_name ORDER BY n DESC,group_name LIMIT 50');
  return '🔐 Активные подписки по группам\n'+(groups.map(g=>g.group_name+': '+g.n).join('\n')||'Подписок нет.');
 }
 if(arg==='queue'){
  const jobs=await rows(env,"SELECT kind,state,count(*) AS n FROM jobs WHERE state IN ('pending','retry','sending','uncertain','failed') GROUP BY kind,state");
  const due=await one(env,"SELECT count(*) AS n,min(due_at) AS oldest FROM jobs WHERE state IN ('pending','retry') AND due_at<=? AND expires_at>?",now,now);
  return '🔐 Очередь уведомлений\nГотовы к отправке сейчас: '+due.n+'\n'+(jobs.map(j=>`${j.kind} / ${j.state}: ${j.n}`).join('\n')||'Очередь пуста.')+'\n\nБудущие pending — нормальные запланированные задания. uncertain означает неопределённый результат; автоматически повторно не отправляется.';
 }
 if(arg==='errors'){
  const errors=await rows(env,"SELECT outcome,count(*) AS n FROM attempts WHERE at>=? AND outcome!='sent' GROUP BY outcome ORDER BY n DESC",now-86400000);
  const updates=await one(env,"SELECT count(*) AS n FROM updates WHERE state='failed' AND created_at>=?",now-86400000);
  return '🔐 Ошибки и переносы за 24 часа\n'+(errors.map(x=>x.outcome+': '+x.n).join('\n')||'Ошибок доставки в журнале нет.')+'\nОшибок обработки команд: '+updates.n+'\nrate_budget/rate_limit — отложенная попытка, не обязательно потерянное сообщение.';
 }
 if(arg==='source'){
  const s=await rows(env,'SELECT status,count(*) AS n,min(checked_at) AS oldest,max(checked_at) AS newest FROM schedules WHERE date=? GROUP BY status',dayKey(now));
  return '🔐 Кеш расписаний на '+dayKey(now)+'\n'+(s.map(x=>`${x.status}: ${x.n} групп; последняя успешная проверка ${age(x.newest,now)}`).join('\n')||'Данных в кеше пока нет.')+'\nДля запроса сайта: /admin refresh';
 }
 if(arg==='refresh'){
  const saved=await one(env,'SELECT group_id,group_name FROM users WHERE user_id=?',u.user_id);
  if(!saved)return 'Сначала выбери свою группу через /start.';
  if(!await lock(env,'admin:refresh',now,60000))return 'Обновление уже запрошено. Повторить можно через минуту.';
  const s=await getSchedule(env,saved.group_id,dayKey(now),now,{force:true});
  const labels={confirmed:'подтверждено',unpublished:'дата ещё не опубликована',network_error:'ошибка запроса',invalid:'неожиданная структура страницы',loading:'запрос уже выполняется'};
  return `🔐 Проверка источника\n${saved.group_name} · ${s.date}\nРезультат: ${labels[s.status]??'нет надёжных данных'}\n${s.status==='confirmed'?'Пар в группе: '+s.lessons.length+'\n':''}Последняя успешная проверка: ${age(s.checked_at,now)}\nОткрыть расписание: 📅 Сегодня`;
 }
 return 'Неизвестная команда. Список: /admin';
}
