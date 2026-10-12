"""Morning Telegram schedule for MKGiK group ZU-41/23.

Actual timetable entries come only from the public MS Timetables page.
Groq is optional and is used only for a brief commentary, never as a source.
"""

from __future__ import annotations

import argparse
import html
import os
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime
from typing import Sequence
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

SCHEDULE_URL = (
    "https://site.mstimetables.ru/"
    "01a011c0a5b475b38b2f1e82c13ccb26/groups/63"
)
GROUP_NAME = "ЗУ-41/23"
TZ = ZoneInfo("Europe/Moscow")
GROQ_MODEL = "openai/gpt-oss-20b"

DAYS_RU = [
    "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"
]
DATE_LINE = re.compile(r"^(\d{2}\.\d{2}\.\d{4})(?:\s|$)")
WEEKDAY = re.compile(r"\b(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)\b", re.I)
TIME_RANGE = re.compile(r"^(\d{2}):(\d{2})\s*[-–—]\s*(\d{2}):(\d{2})$")
SUBGROUP = re.compile(r"^(?:п\s*/\s*гр|подгруппа)\s*([12])$", re.I)
COLUMN_LABELS = {"пара", "время", "предмет", "преподаватель", "аудитория"}


@dataclass(frozen=True)
class Variant:
    subject: str
    teacher: str = ""
    room: str = ""
    subgroup: str = ""  # 1, 2, or empty for whole group


@dataclass(frozen=True)
class Lesson:
    number: int
    time: str
    variants: tuple[Variant, ...]


def normalize(line: str) -> str:
    return re.sub(r"\s+", " ", line.replace("\xa0", " ")).strip()


def split_lines(body: str) -> list[str]:
    return [item for raw in body.splitlines() if (item := normalize(raw))]


def _is_day_heading(lines: Sequence[str], i: int) -> bool:
    """Identify a genuine day heading, not the '12.10 - 18.10' weekly range."""
    match = DATE_LINE.match(lines[i])
    if not match:
        return False
    after_date = lines[i][match.end():].strip()
    if WEEKDAY.search(after_date):
        return True
    # Some layouts put the day of the week on the next line.
    return not after_date and i + 1 < len(lines) and bool(WEEKDAY.search(lines[i + 1]))


def _parse_variant_parts(parts: Sequence[str], subgroup: str) -> Variant:
    if not parts:
        raise ValueError("Пустой вариант предмета")
    if len(parts) >= 3:
        return Variant(" ".join(parts[:-2]), parts[-2], parts[-1], subgroup)
    if len(parts) == 2:
        # At least keep the information as-is instead of inventing a classroom.
        return Variant(parts[0], parts[1], "", subgroup)
    return Variant(parts[0], "", "", subgroup)


def parse_variants(tokens: Sequence[str]) -> tuple[Variant, ...]:
    variants: list[Variant] = []
    subgroup = ""
    current: list[str] = []
    for value in tokens:
        match = SUBGROUP.fullmatch(value)
        if match:
            if current:
                variants.append(_parse_variant_parts(current, subgroup))
                current = []
            subgroup = match.group(1)
        else:
            current.append(value)
    if current:
        variants.append(_parse_variant_parts(current, subgroup))
    if not variants:
        raise ValueError("У пары не найден предмет")
    return tuple(variants)


def parse_schedule(body: str, target: date) -> list[Lesson]:
    """Parse only today's section from the text rendered on the public group page.

    A missing date is a data error, NOT a day off. Missing lessons with an
    explicit 'Нет занятий' marker represent a day off.
    """
    if "data-testid=" in body:
        return parse_html_schedule(body, target)
    lines = split_lines(body)
    date_str = target.strftime("%d.%m.%Y")
    start: int | None = None
    for i, line in enumerate(lines):
        if _is_day_heading(lines, i) and line.startswith(date_str):
            start = i + 1
            break
    if start is None:
        raise ValueError(f"Дата {date_str} не найдена в расписании. Страница могла измениться.")

    end = len(lines)
    for i in range(start, len(lines)):
        if _is_day_heading(lines, i) or "All Rights Reserved" in lines[i]:
            end = i
            break

    section = [line for line in lines[start:end] if line.casefold() not in COLUMN_LABELS]
    if any("нет занятий" in line.casefold() for line in section):
        return []

    lessons: list[Lesson] = []
    pos = 0
    while pos < len(section):
        pair_number = section[pos]
        if (
            pair_number.isdigit()
            and 1 <= int(pair_number) <= 12
            and pos + 1 < len(section)
            and TIME_RANGE.fullmatch(section[pos + 1])
        ):
            num = int(pair_number)
            time = section[pos + 1]
            pos += 2
            parts: list[str] = []
            while pos < len(section):
                if (
                    section[pos].isdigit()
                    and 1 <= int(section[pos]) <= 12
                    and pos + 1 < len(section)
                    and TIME_RANGE.fullmatch(section[pos + 1])
                ):
                    break
                parts.append(section[pos])
                pos += 1
            variants = parse_variants(parts)
            lessons.append(Lesson(num, time, variants))
        else:
            pos += 1

    if not lessons:
        # Do not silently claim an empty timetable when the HTML/layout changes.
        raise ValueError(f"Не удалось распознать ни одной пары на {date_str}, и нет отметки 'Нет занятий'.")
    return lessons


def parse_html_schedule(body: str, target: date) -> list[Lesson]:
    """Read named HTML cells, so absent classrooms cannot shift other fields."""
    soup = BeautifulSoup(body, "html.parser")
    if soup.title is None or GROUP_NAME not in soup.title.get_text():
        raise ValueError("Сайт вернул другую группу или неизвестную страницу")
    matches = []
    for day in soup.select('[data-testid^="LessonsDay-"]'):
        title = day.select_one('[data-testid="LessonsDayTitle"]')
        if title and normalize(title.get_text(" ", strip=True)).startswith(target.strftime("%d.%m.%Y")):
            matches.append(day)
    if len(matches) != 1:
        raise ValueError("Дата отсутствует или неоднозначна; отсутствие данных не означает выходной")
    day = matches[0]
    lessons = []
    for slot in day.select('[data-testid^="LessonsSlot-"]'):
        number = slot.select_one('[data-testid="LessonNumber"]')
        time = slot.select_one('[data-testid="LessonSlotTime"]')
        if not number or not time:
            raise ValueError("Не удалось прочитать номер и время пары")
        number_text = normalize(number.get_text(" ", strip=True))
        time_text = normalize(time.get_text(" ", strip=True))
        if not number_text.isdigit() or not TIME_RANGE.fullmatch(time_text):
            raise ValueError("Неизвестный формат номера или времени пары")
        variants = []
        for item in slot.select('[data-testid="Lesson"]'):
            # The site may show an explicit window in a subgroup.
            if "info-lesson--window" in item.get("class", []):
                continue
            subject = item.select_one('[data-testid="LessonSubject"]')
            if subject is None:
                raise ValueError("У занятия отсутствует поле предмета")
            subgroup_node = subject.select_one('.lesson-subgroup')
            subgroup = ""
            if subgroup_node:
                label = normalize(subgroup_node.get_text(" ", strip=True))
                match = SUBGROUP.fullmatch(label)
                if not match:
                    raise ValueError("Неизвестный формат подгруппы")
                subgroup = match.group(1)
                subgroup_node.decompose()
            subject_text = normalize(subject.get_text(" ", strip=True))
            if not subject_text:
                raise ValueError("У занятия пустой предмет")
            teacher = item.select_one('[data-testid="LessonPeople"]')
            room = item.select_one('[data-testid="LessonCabinet"]')
            variants.append(Variant(subject_text,
                normalize(teacher.get_text("; ", strip=True)) if teacher else "",
                normalize(room.get_text(" ", strip=True)) if room else "", subgroup))
        if variants:
            lessons.append(Lesson(int(number_text), time_text, tuple(variants)))
    empty = day.select_one('[data-testid="LessonsDayEmpty"]')
    if not lessons and not (empty and normalize(empty.get_text()).casefold() == "нет занятий"):
        raise ValueError("Не распознаны занятия и нет явной отметки 'Нет занятий'")
    if lessons and empty:
        raise ValueError("Противоречивые данные расписания")
    return lessons


def fetch_schedule_text(url: str = SCHEDULE_URL) -> str:
    response = requests.get(url, params={"date": datetime.now(TZ).date().isoformat()},
                            timeout=(10, 35), headers={"User-Agent": "ZU41ScheduleBot/1.0"})
    if response.status_code != 200:
        raise RuntimeError(f"Сайт расписания вернул HTTP {response.status_code}")
    response.encoding = "utf-8"
    if len(response.content) > 5_000_000:
        raise RuntimeError("Неожиданно большой ответ сайта расписания")
    return response.text


def filtered_variants(lesson: Lesson, preferred: str) -> list[Variant]:
    """Show all variants by default, or common + selected subgroup."""
    if preferred not in ("1", "2"):
        return list(lesson.variants)
    return [variant for variant in lesson.variants if not variant.subgroup or variant.subgroup == preferred]


def build_message(lessons: Sequence[Lesson], target: date, subgroup: str = "", ai_comment: str = "") -> str:
    header = f"📅 <b>{target.strftime('%d.%m.%Y')} — {DAYS_RU[target.weekday()].capitalize()}</b>\n"
    header += f"🎓 <b>{html.escape(GROUP_NAME)}</b>"
    if subgroup in ("1", "2"):
        header += f" · подгруппа {subgroup}"
    blocks = [header]
    shown: list[Lesson] = []
    for lesson in lessons:
        variants = filtered_variants(lesson, subgroup)
        if not variants:
            continue
        shown.append(lesson)
        block = [f"<b>{lesson.number}-я пара · {html.escape(lesson.time)}</b>"]
        for variant in variants:
            label = f"[{variant.subgroup}] " if variant.subgroup else ""
            block.append(f"📚 {label}{html.escape(variant.subject)}")
            if variant.teacher:
                block.append(f"👨‍🏫 {html.escape(variant.teacher)}")
            if variant.room:
                block.append(f"📍 {html.escape(variant.room)}")
        blocks.append("\n".join(block))
    if not shown:
        blocks.append("На сайте указано: занятий нет." if not lessons else "Для выбранной подгруппы занятия не указаны; проверь исходное расписание.")
    else:
        first_time = shown[0].time.split("-")[0].split("–")[0].strip()
        last_time = shown[-1].time.rsplit("-", 1)[-1].rsplit("–", 1)[-1].strip()
        blocks.append(f"Всего пар: <b>{len(shown)}</b> · {html.escape(first_time)}–{html.escape(last_time)}")
        if ai_comment:
            blocks.append("🤖 " + html.escape(ai_comment))
    blocks.append(f'<a href="{html.escape(SCHEDULE_URL, quote=True)}">Открыть исходное расписание</a>')
    message = "\n\n".join(blocks)
    if len(message) > 4000:
        raise RuntimeError("Сообщение превысило лимит Telegram; нужно разбить его на части.")
    return message


def ai_commentary(lessons: Sequence[Lesson], subgroup: str, api_key: str) -> str:
    """Generate optional commentary ONLY, based on verifiable aggregates."""
    if not api_key:
        return ""
    visible = [lesson for lesson in lessons if filtered_variants(lesson, subgroup)]
    if not visible:
        return ""
    first = visible[0].time.split("-")[0].split("–")[0].strip()
    last = visible[-1].time.rsplit("-", 1)[-1].rsplit("–", 1)[-1].strip()
    has_subgroups = any(v.subgroup for lesson in visible for v in filtered_variants(lesson, subgroup))
    candidates = [
        f"Сегодня {len(visible)} пар: с {first} до {last}.",
        f"Занятия начинаются в {first} и заканчиваются в {last}; всего пар — {len(visible)}.",
    ]
    if has_subgroups:
        candidates.append(f"Сегодня {len(visible)} пар; в расписании есть разделение на подгруппы.")
    data = "Выбери и верни без изменений ровно одну краткую сводку из списка:\n" + "\n".join(candidates)
    try:
        reply = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": GROQ_MODEL,
                "temperature": 0.1,
                "max_completion_tokens": 120,
                "messages": [
                    {"role": "system", "content": (
                        "Ты составляешь короткий комментарий к расписанию колледжа на русском языке. "
                        "Напиши ОДНО простое предложение, не больше 130 символов. "
                        "Не придумывай предметы, аудитории, преподавателей, переносы, отмены и не давай советов. "
                        "Используй ТОЛЬКО проверенные агрегированные факты пользователя."
                    )},
                    {"role": "user", "content": data},
                ],
            },
            timeout=18,
        )
        if reply.status_code != 200:
            print(f"Groq недоступен (HTTP {reply.status_code}); отправляю без AI-сводки.")
            return ""
        message = reply.json()["choices"][0]["message"]["content"]
        message = normalize(message.replace("\n", " ")).strip('"“”')
        # Only factual, prevalidated summaries can be appended; model output is untrusted.
        return message if message in candidates else ""
    except Exception as error:
        print(f"Groq ответил с ошибкой ({type(error).__name__}); продолжаю без нейросети.")
        return ""


def send_telegram(text: str, token: str, chat_id: str) -> int:
    """Never print exception URLs containing bot tokens in public Actions logs."""
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "link_preview_options": {"is_disabled": True},
            },
            timeout=25,
        )
    except requests.RequestException as error:
        raise RuntimeError("Нет соединения с Telegram API.") from None
    if response.status_code != 200:
        raise RuntimeError(
            f"Telegram вернул HTTP {response.status_code}. "
            "Проверьте TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN и команду /start."
        )

    try:
        payload = response.json()
        message_id = payload["result"]["message_id"]
        if payload.get("ok") is not True or not isinstance(message_id, int):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("Telegram API не подтвердил отправку сообщения.") from None
    return message_id


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily MKGiK ZU-41/23 Telegram schedule")
    parser.add_argument("--dry-run", action="store_true", help="Only print actual scraped timetable, without Telegram")
    args = parser.parse_args()

    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    groq_key = os.getenv("GROQ_API_KEY", "").strip()
    subgroup = os.getenv("SUBGROUP", "").strip()

    if not args.dry_run and (not token or not chat_id):
        raise RuntimeError("Добавьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в Secrets репозитория.")
    if subgroup and subgroup not in ("1", "2"):
        raise RuntimeError("SUBGROUP должен быть пустым, 1 или 2.")

    today = datetime.now(TZ).date()
    try:
        body = fetch_schedule_text()
        lessons = parse_schedule(body, today)
    except Exception as error:
        if not args.dry_run and token and chat_id:
            warning = (
                f"⚠️ Не удалось проверить расписание {GROUP_NAME} за {today:%d.%m.%Y}. "
                f"Проверь сайт вручную: {SCHEDULE_URL}"
            )
            try:
                send_telegram(warning, token, chat_id)
            except Exception:
                print("Не удалось отправить предупреждение в Telegram.")
        raise RuntimeError(f"Ошибка получения расписания: {str(error)[:180]}") from None

    comment = ai_commentary(lessons, subgroup, groq_key) if not args.dry_run else ""
    msg = build_message(lessons, today, subgroup, comment)
    if args.dry_run:
        print(msg)
    else:
        message_id = send_telegram(msg, token, chat_id)
        print(f"Telegram API: ok=true; message_id={message_id}")
        print(f"Расписание {GROUP_NAME} на {today:%d.%m.%Y} отправлено, пар: {len(lessons)}.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ОШИБКА: {exc}", file=sys.stderr)
        sys.exit(1)
