"""Offline unit tests using a synthetic page in the format observed at MS Timetables."""

import unittest
from unittest.mock import patch, Mock
from datetime import date

from bot import build_message, parse_schedule, filtered_variants, send_telegram, ai_commentary

HTML = '''<html><title>Расписание ЗУ-41/23</title>
<div data-testid="LessonsDay-1"><div data-testid="LessonsDayTitle">12.10.2026 Понедельник</div>
<div data-testid="LessonsSlot-1"><div data-testid="LessonNumber">1</div>
<div data-testid="LessonSlotTime">09:00-10:30</div>
<div data-testid="Lesson"><div data-testid="LessonSubject"><div class="lesson-subgroup">п/гр1</div>Предмет А</div><div data-testid="LessonPeople">Иванов</div></div>
<div data-testid="Lesson"><div data-testid="LessonSubject"><div class="lesson-subgroup">п/гр2</div>Предмет Б</div><div data-testid="LessonPeople">Петров</div><div data-testid="LessonCabinet">305</div></div>
</div></div></html>'''

SAMPLE = """
МКГиК
Предыдущая неделя
12.10.2026 - 18.10.2026
Сегодня
Следующая неделя
12.10.2026 Понедельник(сегодня)
Пара
Время
Предмет
Преподаватель
Аудитория
1
09:00-10:30
МДК 02.03 Экономическая оценка объектов недвижимости
Романенко Л. А.
305
2
10:40-12:10
ОП.07 Правовое обеспечение профессиональной деятельности
Лебедев С. В.
509
3
13:00-14:30
ОП.06 Основы экономики, менеджмента и маркетинга
Романенко Л. А.
305
13.10.2026 Вторник
Пара
Время
Предмет
Преподаватель
Аудитория
1
09:00-10:30
п/гр1
МДК 04.01 Мониторинг состояния земель
Славина Н. Г.
304
п/гр2
МДК 02.01 Техническая оценка
Морозова Л. А.
401
2
10:40-12:10
МДК 01.02 Топографические съемки
Глинкова О. М.
316
14.10.2026 Среда
Пара
Время
Предмет
Преподаватель
Аудитория
Нет занятий
18.10.2026 Воскресенье
Нет занятий
2016 - 2026 © Timetable, All Rights Reserved
"""


class ParserTests(unittest.TestCase):
    def test_html_missing_room_keeps_fields_and_subgroups(self):
        lessons = parse_schedule(HTML, date(2026, 10, 12))
        a, b = lessons[0].variants
        self.assertEqual((a.subject, a.teacher, a.room, a.subgroup), ('Предмет А', 'Иванов', '', '1'))
        self.assertEqual((b.subject, b.teacher, b.room, b.subgroup), ('Предмет Б', 'Петров', '305', '2'))

    def test_html_missing_date_is_error(self):
        with self.assertRaises(ValueError):
            parse_schedule(HTML, date(2026, 10, 13))

    @patch('bot.requests.post')
    def test_groq_failure_does_not_block_telegram(self, post):
        response = Mock(status_code=200)
        response.json.return_value = {'ok': True, 'result': {'message_id': 123}}
        post.side_effect = [TimeoutError('private details'), response]
        lessons = parse_schedule(HTML, date(2026, 10, 12))
        comment = ai_commentary(lessons, '', 'test-key')
        self.assertEqual(comment, '')
        self.assertEqual(send_telegram(build_message(lessons, date(2026, 10, 12), ai_comment=comment), 'test-token', 'test-chat'), 123)

    @patch('bot.requests.post')
    def test_groq_invented_subject_is_discarded(self, post):
        post.return_value.status_code = 200
        post.return_value.json.return_value = {'choices': [{'message': {'content': 'Сегодня математика отменена.'}}]}
        self.assertEqual(ai_commentary(parse_schedule(HTML, date(2026, 10, 12)), '', 'test-key'), '')

    @patch('bot.requests.post')
    def test_telegram_http_200_without_ok_is_failure(self, post):
        post.return_value.status_code = 200
        post.return_value.json.return_value = {'ok': False}
        with self.assertRaises(RuntimeError):
            send_telegram('test', 'test-token', 'test-chat')

    def test_filtered_empty_not_claimed_as_day_off(self):
        lessons = parse_schedule(HTML, date(2026, 10, 12))
        from bot import Lesson
        only_first = [Lesson(1, lessons[0].time, (lessons[0].variants[0],))]
        message = build_message(only_first, date(2026, 10, 12), subgroup='2')
        self.assertIn('не указаны', message)
        self.assertNotIn('занятий нет', message)

    def test_monday(self):
        lessons = parse_schedule(SAMPLE, date(2026, 10, 12))
        self.assertEqual(len(lessons), 3)
        self.assertEqual(lessons[0].time, "09:00-10:30")
        self.assertEqual(lessons[1].variants[0].teacher, "Лебедев С. В.")
        message = build_message(lessons, date(2026, 10, 12))
        self.assertIn("Всего пар: <b>3</b>", message)
        self.assertIn("305", message)

    def test_two_subgroups(self):
        lessons = parse_schedule(SAMPLE, date(2026, 10, 13))
        self.assertEqual(len(lessons), 2)
        self.assertEqual(len(lessons[0].variants), 2)
        self.assertEqual(lessons[0].variants[0].subgroup, "1")
        self.assertEqual(lessons[0].variants[1].subgroup, "2")
        self.assertEqual(len(filtered_variants(lessons[0], "2")), 1)
        text = build_message(lessons, date(2026, 10, 13), subgroup="2")
        self.assertIn("Морозова Л. А.", text)
        self.assertNotIn("Славина Н. Г.", text)
        self.assertIn("Глинкова О. М.", text)

    def test_day_off(self):
        self.assertEqual(parse_schedule(SAMPLE, date(2026, 10, 14)), [])
        self.assertEqual(parse_schedule(SAMPLE, date(2026, 10, 18)), [])

    def test_missing_day_not_mistaken_for_day_off(self):
        with self.assertRaises(ValueError):
            parse_schedule(SAMPLE, date(2026, 10, 15))

    def test_dont_return_other_date(self):
        result = parse_schedule(SAMPLE, date(2026, 10, 12))
        self.assertNotIn("Топографические", build_message(result, date(2026, 10, 12)))


if __name__ == "__main__":
    unittest.main()
