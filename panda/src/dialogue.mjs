// Conversation continuity checks, independent of the model and its provider.
export const normalizeReply=text=>String(text??'').normalize('NFKC').toLocaleLowerCase('ru').replace(/[\p{P}\p{Z}\s]/gu,'');
const greeting=/^(?:привет(?:ик)?|здравствуй(?:те)?|доброе утро|добрый (?:день|вечер)|салам|salam|hello|hi|hey)(?=[^\p{L}]|$)/iu;
export const basicGreeting=text=>new Set(['привет','приветик','здравствуй','здравствуйте','доброеутро','добрыйдень','добрыйвечер','салам','salam','hello','hi','hey']).has(normalizeReply(text));
export function repeatedReply(text,previous){
 const normalized=normalizeReply(text);if(!normalized)return false;
 return previous.some(old=>normalizeReply(old)===normalized||(greeting.test(text.trim())&&greeting.test(String(old).trim())));
}
