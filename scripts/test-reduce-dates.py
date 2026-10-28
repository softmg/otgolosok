import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

PATH = pathlib.Path(__file__).parents[1] / ".claude" / "skills" / "reduce-dates" / "scripts" / "count_dates.py"
SPEC = importlib.util.spec_from_file_location("count_dates", PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MentionsTest(unittest.TestCase):
    def test_date_forms_count_once_each(self):
        cases = (
            ("9 февраля 1885 года пришли читатели", ["9 февраля 1885"]),
            ("в декабре 1993-го здания передали", ["декабре 1993-го"]),
            ("в 1838–1840 годах перестроили", ["1838–1840"]),
            ("в 1980-х и в начале XX века", ["1980-х", "XX век"]),
            ("палаты конца XVII века", ["XVII век"]),
            ("в 2010 году", ["2010"]),
        )
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(MODULE.mentions(text), expected)

    def test_numbers_that_are_not_years_are_skipped(self):
        for text in ("школа № 1216", "школа №1216", "зал на 1200 мест", "1500 метров", "6000 квадратных метров", "дом 12, 3,1415"):
            with self.subTest(text=text):
                self.assertEqual(MODULE.mentions(text), [])


class ReportTest(unittest.TestCase):
    def run_report(self, paragraphs: list[str], *flags: str) -> str:
        places = [{"placeId": "osm:node:1", "name": "Точка", "story": {"paragraphs": [{"text": t} for t in paragraphs]}}]
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "captured.json"
            path.write_text(json.dumps({"places": places}, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run([sys.executable, "-I", str(PATH), str(path), *flags], capture_output=True, text=True, check=True)
        return result.stdout

    def test_story_over_the_limit_is_reported_with_its_dates(self):
        out = self.run_report(["В 1884 году утвердили, в 1885 году открыли.", "В 1989 году решили, в 1993-м передали, с 1995 года строили."])
        self.assertIn("5 дат (в абзаце до 3) — Точка [osm:node:1]", out)
        self.assertIn("абзац 1: 1989; 1993-м; 1995", out)

    def test_limits_are_inclusive_and_configurable(self):
        two_paragraphs = ["В 1884 году утвердили, в 1885 году открыли.", "В 1989 году решили, в 1993-м передали."]
        self.assertEqual(self.run_report(two_paragraphs), "")
        self.assertIn("4 дат", self.run_report(two_paragraphs, "--max-story", "3"))
        self.assertIn("4 дат", self.run_report(two_paragraphs, "--max-paragraph", "1"))


if __name__ == "__main__":
    unittest.main()
