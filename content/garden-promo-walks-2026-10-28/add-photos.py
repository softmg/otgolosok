"""Adds Commons photos of walk stops to the editorial catalog backend/place-images-editorial.json.

Usage: python3 -I add-photos.py photos.json
photos.json: [{"placeId": "osm:node:1", "file": "File:….jpg", "alt": "…"}]. Downloads Wikimedia standard thumbnails
(250 px preview, 960 px full) into public/images/places under content-hash names and records author and licence from
the file's Commons metadata. Free licences only: CC0, public domain, CC BY, CC BY-SA, FAL.
"""

import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "backend" / "place-images-editorial.json"
IMAGES = ROOT / "public" / "images" / "places"
API = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "otgolosok-editorial/1.0 (place photo catalog)"}
FREE = re.compile(r"^(CC0|Public domain|PD.*|CC BY(-SA)? [0-9.]+|FAL|No restrictions)$", re.IGNORECASE)
WIDTHS = {"thumbnail": 250, "src": 960}


def fetch(url: str) -> bytes:
    """GET with bounded exponential backoff on network errors, 429 and 5xx."""
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(2 ** attempt * 2)
    raise RuntimeError(f"Не удалось скачать {url}")


def info(title: str, width: int) -> dict:
    query = urllib.parse.urlencode({"action": "query", "titles": title, "prop": "imageinfo", "format": "json",
                                    "iiprop": "url|size|extmetadata", "iiurlwidth": width})
    for attempt in range(6):
        data = json.loads(fetch(f"{API}?{query}"))
        if "error" not in data:
            page = next(iter(data["query"]["pages"].values()))
            if "imageinfo" not in page:
                raise RuntimeError(f"Нет файла {title}")
            return page["imageinfo"][0]
        time.sleep(2 ** attempt * 2)
    raise RuntimeError(f"Commons API недоступен для {title}")


def plain(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html)).strip()


def main() -> None:
    requests = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    for request in requests:
        place_id, title = request["placeId"], request["file"]
        if place_id in catalog:
            print(f"уже есть: {place_id}")
            continue
        meta = info(title, WIDTHS["src"])
        ext = meta.get("extmetadata", {})
        license_name = plain(ext.get("LicenseShortName", {}).get("value", ""))
        if not FREE.match(license_name) or ext.get("NonFree", {}).get("value") == "true":
            raise SystemExit(f"Несвободная лицензия {license_name!r}: {title}")
        author = plain(ext.get("Artist", {}).get("value", "")) or plain(ext.get("Credit", {}).get("value", ""))
        if not author:
            raise SystemExit(f"Не указан автор: {title}")
        page_url = meta["descriptionurl"]
        license_url = ext.get("LicenseUrl", {}).get("value") or page_url
        kind, osm_id = place_id.split(":")[1:]
        entry = {}
        for field, width in WIDTHS.items():
            thumb = info(title, width) if field != "src" else meta
            body = fetch(thumb["thumburl"])
            if body[:3] != b"\xff\xd8\xff":
                raise SystemExit(f"Не JPEG: {thumb['thumburl']}")
            name = f"{kind}-{osm_id}-{hashlib.sha256(body).hexdigest()[:12]}.jpg"
            (IMAGES / name).write_bytes(body)
            entry[field] = f"/images/places/{name}"
            if field == "src":
                entry["width"], entry["height"] = thumb["thumbwidth"], thumb["thumbheight"]
        catalog[place_id] = {"thumbnail": entry["thumbnail"], "src": entry["src"], "width": entry["width"],
                             "height": entry["height"], "alt": request["alt"], "author": author, "sourceUrl": page_url,
                             "license": license_name, "licenseUrl": license_url,
                             "retrievedAt": datetime.now(tz=timezone.utc).date().isoformat(),  # noqa: UP017 (system Python 3.9)
                             "modifications": "Размер уменьшен Wikimedia Commons; превью обрезается при показе."}
        print(f"добавлено: {place_id} — {author}, {license_name}")
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
