#!/usr/bin/env python3
"""Import a versioned Moscow attraction catalog from an OSM PBF."""

import argparse
import hashlib
import json
import math
import re
from pathlib import Path

try:
    import osmium
except ModuleNotFoundError:  # Pure helper tests do not need the PBF parser.
    osmium = None

FIELDS = ("name", "name:ru", "alt_name", "old_name", "tourism", "historic", "heritage", "leisure", "amenity",
          "building", "memorial", "artwork_type", "inscription", "subject", "subject:wikidata",
          "addr:city", "addr:street", "addr:housenumber", "wikidata", "wikipedia", "architect")
TOURISM = {"attraction", "museum", "gallery", "artwork", "viewpoint", "zoo", "theme_park"}
LEISURE = {"park", "garden"}
TOKEN = re.compile(r"[\wа-яё]+", re.IGNORECASE)


def distance(a, b):
    lat = math.radians((a["location"]["lat"] + b["location"]["lat"]) / 2)
    dx = math.radians(a["location"]["lon"] - b["location"]["lon"]) * math.cos(lat)
    dy = math.radians(a["location"]["lat"] - b["location"]["lat"])
    return 6371000 * math.sqrt(dx * dx + dy * dy)


def duplicate_candidates(items):
    """Conservative review list; importer never merges distinct OSM objects."""
    by_wikidata = {}
    for item in items:
        qid = item["tags"].get("wikidata")
        if qid: by_wikidata.setdefault(qid, []).append(item["placeId"])
    result = [{"reason": "wikidata", "value": qid, "placeIds": ids}
              for qid, ids in by_wikidata.items() if len(ids) > 1]
    # Only compare nearby normalized names; avoid quadratic comparison across Moscow.
    buckets = {}
    for item in items:
        name = " ".join(TOKEN.findall(item["name"].casefold().replace("ё", "е")))
        if name: buckets.setdefault(name, []).append(item)
    for name, group in buckets.items():
        if len(group) < 2: continue
        for index, left in enumerate(group):
            near = [right["placeId"] for right in group[index + 1:] if distance(left, right) <= 30]
            if near: result.append({"reason": "nearby_name", "value": name, "placeIds": [left["placeId"], *near]})
    return result


def point_in_geometry(point, geometry):
    polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    def inside(ring):
        x, y = point["lon"], point["lat"]; contained = False
        for index, a in enumerate(ring):
            b = ring[index - 1]
            if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]: contained = not contained
        return contained
    return any(inside(polygon[0]) and not any(inside(hole) for hole in polygon[1:]) for polygon in polygons)


def representative_point(points):
    """Return a stable point on the geometry, never an unverified entrance."""
    if len(points) == 1: return {"lat": round(points[0][0], 7), "lon": round(points[0][1], 7)}
    # The midpoint of a real segment is guaranteed to remain on the geometry.
    index = (len(points) - 1) // 2
    left, right = points[index], points[min(index + 1, len(points) - 1)]
    return {"lat": round((left[0] + right[0]) / 2, 7), "lon": round((left[1] + right[1]) / 2, 7)}


def polygon_geometry(polygons):
    """Build GeoJSON from outer/inner rings while retaining relation topology."""
    converted = [[[[round(lon, 7), round(lat, 7)] for lat, lon in ring] for ring in polygon]
                 for polygon in polygons if polygon and polygon[0]]
    if not converted: return None
    return {"type": "Polygon", "coordinates": converted[0]} if len(converted) == 1 else {"type": "MultiPolygon", "coordinates": converted}


def geometry_covered(geometry, boundary):
    """Require the complete object geometry to remain inside the verified boundary."""
    if geometry["type"] == "Point": coordinates = [geometry["coordinates"]]
    elif geometry["type"] == "LineString": coordinates = geometry["coordinates"]
    elif geometry["type"] == "Polygon": coordinates = [point for ring in geometry["coordinates"] for point in ring]
    elif geometry["type"] == "MultiPolygon": coordinates = [point for polygon in geometry["coordinates"] for ring in polygon for point in ring]
    else: raise ValueError("Unsupported imported geometry")
    return bool(coordinates) and all(point_in_geometry({"lon": point[0], "lat": point[1]}, boundary) for point in coordinates)


def selected(tags):
    values = {key: tags[key] for key in FIELDS if tags.get(key)}
    named = bool(values.get("name") or values.get("name:ru"))
    eligible = (values.get("historic", "no") != "no" or values.get("heritage", "no") != "no"
                or values.get("tourism") in TOURISM or (named and values.get("leisure") in LEISURE)
                or (values.get("building") not in (None, "no") and
                    any(values.get(key) for key in ("wikidata", "wikipedia", "architect"))))
    return values if eligible and named else None


# Pure helper tests import this module without pyosmium installed.
_HandlerBase: type = osmium.SimpleHandler if osmium else object


class Attractions(_HandlerBase):
    def __init__(self, boundary_relation_id=None):
        super().__init__(); self.items = []; self.latest = ""; self.skipped = 0; self.boundary_relation_id = boundary_relation_id; self.boundary_version = None

    def add(self, kind, osm_id, tags, points, timestamp, geometry=None):
        if not points:
            self.skipped += 1; return
        point = representative_point(points); lat, lon = point["lat"], point["lon"]
        if 55.05 <= lat <= 56.05 and 36.75 <= lon <= 38.25:
            coordinates = [[round(p[1], 7), round(p[0], 7)] for p in points]
            if geometry is None:
                if kind == "node": geometry = {"type": "Point", "coordinates": coordinates[0]}
                elif len(coordinates) >= 4 and coordinates[0] == coordinates[-1]: geometry = {"type": "Polygon", "coordinates": [coordinates]}
                else: geometry = {"type": "LineString", "coordinates": coordinates}
            self.items.append({"placeId": f"osm:{kind}:{osm_id}", "osmType": kind, "osmId": osm_id,
                               "name": tags.get("name:ru", tags.get("name")), "location": point, "geometry": geometry,
                               "tags": tags, "timestamp": timestamp.isoformat(),
                               "provenance": {"source": "OpenStreetMap", "osmType": kind, "osmId": osm_id,
                                              "timestamp": timestamp.isoformat()}})
            self.latest = max(self.latest, timestamp.isoformat())

    def node(self, node):
        tags = selected(node.tags)
        if tags: self.add("node", node.id, tags, [(node.lat, node.lon)], node.timestamp)

    def way(self, way):
        tags = selected(way.tags)
        if tags: self.add("way", way.id, tags, [(n.lat, n.lon) for n in way.nodes if n.location.valid()], way.timestamp)

    def relation(self, relation):
        if self.boundary_relation_id is not None and relation.id == self.boundary_relation_id:
            self.boundary_version = {"osmType": "relation", "osmId": relation.id, "version": relation.version,
                                     "timestamp": relation.timestamp.isoformat()}

    def area(self, area):
        if area.from_way(): return
        tags = selected(area.tags)
        if tags:
            polygons=[]
            for outer in area.outer_rings():
                outer_points=[(node.lat,node.lon) for node in outer if node.location.valid()]
                holes=[[(node.lat,node.lon) for node in inner if node.location.valid()] for inner in area.inner_rings(outer)]
                polygons.append([outer_points,*[hole for hole in holes if hole]])
            geometry=polygon_geometry(polygons);points=[point for polygon in polygons for ring in polygon for point in ring]
            self.add("relation",area.orig_id(),tags,points,area.timestamp,geometry)


def main():
    if osmium is None: raise SystemExit("Install pyosmium before importing a PBF")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbf", type=Path)
    parser.add_argument("--output", type=Path, default=Path("backend/data/osm-attractions.json"))
    parser.add_argument("--coverage", choices=("bounding-box", "moscow-admin"), default="bounding-box")
    parser.add_argument("--boundary-file", type=Path, help="GeoJSON Polygon/MultiPolygon for verified Moscow boundary")
    parser.add_argument("--source-url", help="Stable download URL recorded as snapshot provenance")
    parser.add_argument("--boundary-relation-id", type=int, default=102269, help="Verified Moscow administrative relation")
    args = parser.parse_args(); handler = Attractions(args.boundary_relation_id if args.coverage == "moscow-admin" else None)
    if args.coverage == "moscow-admin" and not args.boundary_file:
        raise SystemExit("--coverage moscow-admin requires --boundary-file")
    handler.apply_file(str(args.pbf), locations=True, idx="flex_mem")
    if not handler.items: raise SystemExit("No attractions found; refusing to replace catalog")
    if args.coverage == "moscow-admin" and handler.boundary_version is None:
        raise SystemExit("PBF does not contain the verified Moscow boundary relation; refusing complete coverage")
    with args.pbf.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    items = sorted(handler.items, key=lambda item: item["placeId"])
    boundary_checksum = None
    if args.boundary_file:
        boundary_bytes = args.boundary_file.read_bytes(); boundary_checksum = hashlib.sha256(boundary_bytes).hexdigest(); boundary = json.loads(boundary_bytes)
        geometry = boundary["features"][0]["geometry"] if boundary.get("type") == "FeatureCollection" else boundary.get("geometry", boundary)
        items = [item for item in items if geometry_covered(item["geometry"], geometry)]
        if not items: raise SystemExit("Verified boundary removed every attraction; refusing output")
    categories = {}
    for item in items:
        category = next((f"{key}={item['tags'][key]}" for key in ("tourism", "historic", "heritage", "leisure", "building") if item["tags"].get(key)), "other")
        categories[category] = categories.get(category, 0) + 1
    result = {"schemaVersion": 1, "rulesVersion": "moscow-attractions-v1", "source": args.source_url or str(args.pbf),
              "sourceSha256": checksum, "latestEdit": handler.latest,
              "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
              "coverage": "moscow-admin" if args.coverage == "moscow-admin" else "moscow-bounding-box; administrative clipping pending verified boundary",
              "boundary": {"file": str(args.boundary_file), "sha256": boundary_checksum,
                           **(handler.boundary_version or {})} if args.boundary_file else None,
              "report": {"categories": categories, "skippedGeometry": handler.skipped,
                         "duplicateCandidates": duplicate_candidates(items)}, "places": items}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(items)} attractions from {len(handler.items)} candidates; skipped {handler.skipped} incomplete geometries: {args.output}")


if __name__ == "__main__": main()
