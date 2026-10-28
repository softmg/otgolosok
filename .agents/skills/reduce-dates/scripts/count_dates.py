"""Find narrated stories overloaded with dates.

Usage: python3 -I count_dates.py STORIES.json [--max-story 4] [--max-paragraph 2]

STORIES.json is a capture of published stories: {"places": [{"placeId", "name", "story": {"paragraphs": [{"text"}]}}]}
(content/<package>/captured.json and the capture.mjs output share this shape) or a plain list of such places.
Prints the stories that exceed either limit, worst first, with every date mention found. Pure standard library.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

MONTHS = (
    "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|"
    "январе|феврале|марте|апреле|мае|июне|июле|августе|сентябре|октябре|ноябре|декабре"
)
# One mention each: «9 февраля 1885 года», «в декабре 1993-го», «1838–1840 годах», «1980-х», «1895», «XVII века».
DATE = re.compile(
    rf"(?:\d{{1,2}}\s+(?:{MONTHS})\s+)?(?:(?:{MONTHS})\s+)?"
    # Not a year: «№ 1216», «1200 мест», «1500 метров».
    r"(?<![\d.,])(?<!№\s)(?<!№)(?:1[0-9]|20)\d{2}(?:\s*[–—-]\s*(?:1[0-9]|20)?\d{2})?(?:-(?:х|е|го|м|й))?(?![\d.,]\d)"
    r"(?!\s+(?:мест|метр|м\b|км|кв|человек|зрител|экземпляр|руб|штук|томов|книг|единиц))"
    r"|\b[IVXLC]{1,6}(?:\s*[–—-]\s*[IVXLC]{1,6})?\s+(?:век|века|веке|веков|столети)",
    re.IGNORECASE,
)


def mentions(text: str) -> list[str]:
    return [m.group(0).strip() for m in DATE.finditer(text)]


def load(path: str) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["places"] if isinstance(data, dict) else data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stories")
    parser.add_argument("--max-story", type=int, default=4)
    parser.add_argument("--max-paragraph", type=int, default=2)
    args = parser.parse_args()

    flagged = []
    for place in load(args.stories):
        paragraphs = [p["text"] for p in place["story"]["paragraphs"]]
        found = [mentions(text) for text in paragraphs]
        total = sum(len(f) for f in found)
        worst = max((len(f) for f in found), default=0)
        if total > args.max_story or worst > args.max_paragraph:
            flagged.append((total, worst, place, found))
    flagged.sort(key=lambda item: (item[0], item[1]), reverse=True)
    for total, worst, place, found in flagged:
        print(f"{total} дат (в абзаце до {worst}) — {place.get('name') or place['story'].get('title')} [{place.get('placeId', '')}]")
        for index, items in enumerate(found):
            if items:
                print(f"  абзац {index}: {'; '.join(items)}")
    print(f"перегружено датами: {len(flagged)}", file=sys.stderr)


if __name__ == "__main__":
    main()
