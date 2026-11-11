import {OWNER, one, run} from './store.mjs';

export function parseLetterCase(text) {
  const command = String(text || '').trim().replace(/^панда[,!:\s]+/iu, '');
  const match = command.match(/^(?:запомни[,:\s]+)?(?:дальше\s+|теперь\s+)?(?:общайся|отвечай|пиши|переписывайся)\s+(?:мне\s+)?с\s+(маленькой|строчной|большой|заглавной)\s+буквы(?:(?:\s+)(?:во всех чатах|в этом чате|здесь|в чате\s+([^.!?\n]+)|с\s+([^.!?\n]+)))?[.!]*$/iu);
  if (match) {
    return {
      value: /^(?:маленькой|строчной)$/iu.test(match[1]) ? 'lower' : 'normal',
      recipient: (match[2] || match[3])?.trim(),
      all: /\sво всех чатах[.!]*$/iu.test(command),
      local: /\s(?:здесь|в этом чате)[.!]*$/iu.test(command),
    };
  }
  if (/^(?:так\s+)?ты\s+(?:вс[её]\s*равно\s+|вс[её]\s*ровно\s+)?(?:с\s+)?заглавной\s+пишешь[.!]*$/iu.test(command)) {
    return {value: 'lower', local: true};
  }
  return null;
}

export async function saveLetterCase(env, scope, value) {
  await run(env, 'INSERT INTO letter_case_preferences(scope,value) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value', [scope, value]);
}

export async function letterCase(env, scope = OWNER) {
  const pref = await one(env, 'SELECT value FROM letter_case_preferences WHERE scope IN (?,?) ORDER BY CASE WHEN scope=? THEN 0 ELSE 1 END LIMIT 1', [scope, OWNER, scope]);
  return pref?.value || 'normal';
}

export function formatLetterCase(text, value) {
  if (value !== 'lower') return text;
  // Lower the opening of sentences without changing links, commands or acronyms.
  return text.replace(/(^|[!?…]\s+|(?<!\.)\.\s+|\n+)([ \t«„“"—–-]*)(\p{Lu})(?=\p{Ll}|\s|[,.!?]|$)/gu,
    (match, boundary, prefix, initial, offset) => {
      const start = offset + boundary.length + prefix.length;
      if (/^(?:https?:\/\/|www\.)/iu.test(text.slice(start))) return match;
      return boundary + prefix + initial.toLocaleLowerCase('ru');
    });
}
