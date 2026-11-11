export const MAX_MODE_MINUTES = 31 * 24 * 60;
export const MODE_DURATION_ERROR = 'Укажи срок от 1 минуты до 744 часов, например «на 730 часов».';

export const validModeDuration = minutes => Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_MODE_MINUTES;

function plural(number, forms) {
  const last = number % 10;
  return forms[number % 100 >= 11 && number % 100 <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2];
}

export function formatDuration(minutes, unit, accusative = false) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const mins = number => number + ' ' + plural(number, [accusative ? 'минуту' : 'минута', 'минуты', 'минут']);
  if (unit === 'minutes' || !hours) return mins(minutes);
  const hourText = hours + ' ' + plural(hours, ['час', 'часа', 'часов']);
  return rest ? hourText + ' ' + mins(rest) : hourText;
}

export function parseAutoCommand(text) {
  const command = String(text || '').trim().toLowerCase().replace(/ё/g, 'е')
    .replace(/^панда[,!: ]+/u, '').replace(/^пожалуйста[, ]+/u, '');
  if (!/автоответ(?:ы|чик)?(?!\p{L})/u.test(command) || /[«»"\n?]/u.test(command)) return null;
  if (!/^(?:включи|вруби|врубай|поставь|запусти|активируй|сделай|настрой|автоответ(?:чик|ы)?)(?=\s|[.!]|$)/u.test(command)) return null;
  if (/(?:^|\s)(?:не включай|не надо|выключи|отключи|останови)(?=\s|$)/u.test(command)) return null;
  const suffix = command.replace(/[.!]+$/u, '');
  const mention = suffix.match(/(?:^|\s)на\s+(?=-?\d|двенадцать\s+часов|пол\s*часа|сутки)/u);
  const part = mention ? suffix.slice(mention.index).trim().replace(/^на\s+/u, '') :
    suffix.match(/(?:^|\s)(-?\d+(?:[.,]\d+)?\s*(?:час(?:а|ов)?|ч|мин(?:ут[аыу]?)?)|двенадцать\s+часов|пол\s*часа|сутки)$/u)?.[1];
  if (!part) return /(?:^|\s)на(?:\s|$)/u.test(suffix) ? {minutes: null} : {minutes: 120};
  if (/^двенадцать\s+часов(?=\s|$)/u.test(part)) return {minutes: 720};
  if (/^сутки(?=\s|$)/u.test(part)) return {minutes: 1440};
  if (/^пол\s*часа(?=\s|$)/u.test(part)) return {minutes: 30, unit: 'minutes'};
  const duration = part.match(/^(-?\d+(?:[.,]\d+)?)\s*(час(?:а|ов)?|ч|мин(?:ут[аыу]?)?)(?=\s|$)(?:\s+(?:и\s+)?(\d+)\s*мин(?:ут[аыу]?)?(?=\s|$))?/u);
  if (!duration || /^\s+(?:и\s+)?[-+]?\d/u.test(part.slice(duration[0].length))) return {minutes: null};
  const amount = Number(duration[1].replace(',', '.'));
  const isMinutes = duration[2].startsWith('мин');
  if (duration[3] && (isMinutes || amount < 0 || !Number.isInteger(amount) || Number(duration[3]) >= 60)) return {minutes: null};
  return {minutes: amount * (isMinutes ? 1 : 60) + Number(duration[3] || 0), ...(isMinutes ? {unit: 'minutes'} : {})};
}
