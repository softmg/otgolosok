#!/usr/bin/env python3
"""Собрать локальный адресный индекс SQLite из OSM PBF (osmium==4.3.1)."""

import argparse
import hashlib
import json
import math
import os
import sqlite3
import tempfile
from pathlib import Path

import osmium

SOURCE = "https://download.bbbike.org/osm/bbbike/Moscow/Moscow.osm.pbf"
KEYS = (
    "name",
    "name:ru",
    "building",
    "building:part",
    "highway",
    "boundary",
    "admin_level",
    "addr:full",
    "addr:city",
    "addr:street",
    "addr:place",
    "addr:housenumber",
)


def postal_address(tags):
    if tags.get("addr:full"):
        return tags["addr:full"]
    street = tags.get("addr:street") or tags.get("addr:place")
    number = tags.get("addr:housenumber")
    if street and number:
        return f"{tags.get('addr:city') or 'Москва'}, {street}, {number}"
    return None


def feature_kind(tags, area=False):
    if (
        area
        and tags.get("boundary") == "administrative"
        and tags.get("admin_level") in ("8", "9", "10")
        and tags.get("name")
    ):
        return "district"
    if postal_address(tags):
        return "building" if area and tags.get("building", "no") != "no" else "address"
    if not area and tags.get("highway") and (tags.get("name:ru") or tags.get("name")):
        return "street"
    return None


def coordinates(nodes):
    if any(not node.location.valid() for node in nodes):
        raise ValueError("Неполная геометрия")
    return [[round(node.lon, 7), round(node.lat, 7)] for node in nodes]


class AddressIndex(osmium.SimpleHandler):
    def __init__(self, db):
        super().__init__()
        self.db = db
        self.counts = {}
        self.skipped = 0
        self.latest_edit = ""

    def add(self, osm_id, kind, tags, geometry, timestamp):
        def points(value):
            if len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
                yield value
            else:
                for child in value:
                    yield from points(child)

        vertices = list(points(geometry["coordinates"]))
        if not vertices or any(
            not math.isfinite(lon)
            or not math.isfinite(lat)
            or abs(lon) > 180
            or abs(lat) > 90
            for lon, lat in vertices
        ):
            raise ValueError("Некорректные координаты")
        cursor = self.db.execute(
            "INSERT INTO features(osm_id,kind,name,address,geometry) VALUES (?,?,?,?,?)",
            (
                osm_id,
                kind,
                tags.get("name:ru") or tags.get("name"),
                postal_address(tags),
                json.dumps(geometry, ensure_ascii=False, separators=(",", ":")),
            ),
        )
        lons, lats = zip(*vertices)
        self.db.execute(
            "INSERT INTO bounds VALUES (?,?,?,?,?)",
            (cursor.lastrowid, min(lons), max(lons), min(lats), max(lats)),
        )
        self.counts[kind] = self.counts.get(kind, 0) + 1
        self.latest_edit = max(self.latest_edit, timestamp.isoformat())

    def node(self, node):
        tags = {key: node.tags[key] for key in KEYS if key in node.tags}
        if not postal_address(tags):
            return
        if not node.location.valid():
            self.skipped += 1
            return
        self.add(
            f"osm:node:{node.id}",
            "address",
            tags,
            {"type": "Point", "coordinates": [node.lon, node.lat]},
            node.timestamp,
        )

    def way(self, way):
        tags = {key: way.tags[key] for key in KEYS if key in way.tags}
        kind = feature_kind(tags)
        # Closed address outlines are imported by the area handler, with holes.
        if not kind or (kind == "address" and way.is_closed()):
            return
        try:
            points = coordinates(way.nodes)
            if len(points) < 2:
                raise ValueError("Линия без сегментов")
        except (ValueError, osmium.InvalidLocationError):
            self.skipped += 1
            return
        self.add(
            f"osm:way:{way.id}",
            kind,
            tags,
            {"type": "LineString", "coordinates": points},
            way.timestamp,
        )

    def area(self, area):
        tags = {key: area.tags[key] for key in KEYS if key in area.tags}
        kind = feature_kind(tags, area=True)
        if not kind:
            return
        try:
            polygons = [
                [
                    coordinates(outer),
                    *[coordinates(inner) for inner in area.inner_rings(outer)],
                ]
                for outer in area.outer_rings()
            ]
            if not polygons or any(
                len(ring) < 4 or ring[0] != ring[-1]
                for polygon in polygons
                for ring in polygon
            ):
                raise ValueError("Незамкнутый полигон")
        except (ValueError, osmium.InvalidLocationError):
            self.skipped += 1
            return
        osm_type = "way" if area.from_way() else "relation"
        self.add(
            f"osm:{osm_type}:{area.orig_id()}",
            kind,
            tags,
            {"type": "MultiPolygon", "coordinates": polygons},
            area.timestamp,
        )


def build(pbf: Path, output: Path, source_url=SOURCE):
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=".osm-addresses-", suffix=".sqlite", dir=output.parent
    )
    os.close(descriptor)
    db = None
    try:
        db = sqlite3.connect(temporary)
        db.executescript("""
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE features(id INTEGER PRIMARY KEY,osm_id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,name TEXT,address TEXT,geometry TEXT NOT NULL);
            CREATE VIRTUAL TABLE bounds USING rtree(id,min_lon,max_lon,min_lat,max_lat);
        """)
        handler = AddressIndex(db)
        handler.apply_file(str(pbf), locations=True, idx="flex_mem")
        if not sum(handler.counts.values()):
            raise ValueError("В снимке нет адресов и улиц; прежний индекс сохранён")
        with pbf.open("rb") as source:
            checksum = hashlib.file_digest(source, "sha256").hexdigest()
        manifest = {
            "schemaVersion": 1,
            "source": source_url,
            "sourceSha256": checksum,
            "latestEdit": handler.latest_edit,
            "license": "ODbL-1.0",
            "attribution": "© OpenStreetMap contributors",
            "counts": handler.counts,
            "skippedGeometry": handler.skipped,
        }
        db.execute(
            "INSERT INTO metadata VALUES ('manifest',?)",
            (json.dumps(manifest, ensure_ascii=False),),
        )
        db.commit()
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Адресный индекс не прошёл проверку целостности")
        db.close()
        db = None
        os.chmod(temporary, 0o644)
        os.replace(temporary, output)
        return manifest
    finally:
        if db is not None:
            db.close()
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbf", type=Path)
    parser.add_argument(
        "--output", type=Path, default=Path("backend/data/osm-addresses.sqlite")
    )
    parser.add_argument("--source-url", default=SOURCE)
    args = parser.parse_args()
    try:
        manifest = build(args.pbf, args.output, args.source_url)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, f"Не удалось собрать адресный индекс: {error}\n")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
