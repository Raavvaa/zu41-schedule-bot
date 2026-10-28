// These guards limit money tools; they never choose the conversational reply.
export function recordingVeto(text){
 return /(?:не\s+(?:(?:надо|нужно|хочу|будем|стоит|пока|никуда|нигде|ничего|это)\s+)*(?:добавляй|добавлять|записывай|записывать|записать|учитывай|учитывать|вноси|вносить|зачисляй)|без\s+(?:записи|записей|уч[её]та)|просто\s+(?:сказал|рассказываю|рассказал|делюсь|поделился|сообщил))/iu.test(text);
}
export const explicitRecord=text=>/(?:^|[\s,.!?])(?:запиши|добавь|учти|внеси|зачисли|закинь)(?=[\s,.!?:]|$)/iu.test(text)&&!recordingVeto(text);
export function opinionRequest(text){
 if(explicitRecord(text))return false;
 return /(?:как\s+(?:думаешь|считаешь|тебе)|что\s+(?:думаешь|скажешь)|(?<![а-яё])норм(?:ально)?(?:\s+ли)?\s*(?:[?!]|$)|правильно\s+(?:ли|сделал|поступил)|стоит\s+ли|посоветуй)/iu.test(text);
}
export function plannedRequest(text){
 // A wish does not depend on a catalogue of products (coat, shoes, etc.).
 // An actual request to enter an event is not a planned purchase.
 return /(?:хочу|хотел\s+бы|планирую)/iu.test(text)&&!/(?:хочу|хотел\s+бы)\s+(?:записать|учесть|внести|добавить)/iu.test(text);
}
export function conversationOnly(text){
 if(recordingVeto(text))return true;
 if(explicitRecord(text))return false;
 if(opinionRequest(text)||plannedRequest(text))return true;
 // Looking up an earlier operation is read-only, even if the question names
 // an amount. Do not let the current-balance shortcut consume that question.
 if(/последн|предыдущ/iu.test(text)&&/сколько|какая|какой|что|напомни/iu.test(text)&&/добав|пополн|доход|операц|запис|перевод|расход|потрат|спис/iu.test(text))return true;
 return /(?:помнишь|я\s+(?:говорил|рассказывал)|сколько.{0,60}(?:подарили|дали|на\s+др|на\s+день\s+рождения))/iu.test(text);
}
export const giftReference=text=>explicitRecord(text)&&/(?<![а-яё])(?:(?:этот|тот)\s+подарок|(?:эту|ту)\s+сумму|эти\s+\d)(?=[\s,.!?]|\d|$)/iu.test(text)&&!/(?:получил|заработал|подарили|дали)\s/iu.test(text);
export function referenceSource(text,history,now){
 if(!giftReference(text))return null;
 // Referencing a conversational amount needs a current, explicit instruction.
 // Never turn arbitrary older history, an assistant reply or an old command
 // into new money. More than one candidate is ambiguous and needs a question.
 const candidates=history.filter(m=>m.role==='user'&&now>=m.at&&now-m.at<=15*60000&&/\d/u.test(m.content)&&/подар|день\s+рожд|праздник|(?<![а-яё])др(?![а-яё])/iu.test(m.content)&&recordingVeto(m.content));
 return candidates.length===1?candidates[0]:null;
}
export function ledgerClaim(text){
 // Only asserted current account balances belong to the ledger check. A gift,
 // price, past event, plan or quotation can legitimately have other numbers.
 return text.split(/[.!?\n]+/u).some(sentence=>!/(?:ты\s+(?:говорил|сказал|рассказывал|упоминал)|по\s+твоим\s+словам)/iu.test(sentence)&&/(?:у\s+тебя\s+(?:сейчас\s+)?\d|(?:на\s+балансе|в\s+кошельк[ае]|по\s+(?:журналу|записям)|в\s+(?:Сабунчи|карманных|капитале))[^.!?\n]{0,50}\d)/iu.test(sentence));
}
