"""Find areas for new promo walks in a snapshot produced by collect.mjs.

Usage: python3 -I analyze.py SNAPSHOT.json OUT_DIR [--min-stops 10] [--min-audio-min 18]
       [--max-overlap 0.5] [--max-stops 20] [--max-route-km 4] [--max-hop-m 700] [--top 25]
       [--include-minor]

Writes OUT_DIR/candidates.json (every accepted option with its stops) and OUT_DIR/candidates.md
(a summary table). Pure standard library: the skill must run without a project environment.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
METRO_FILES = [
    ROOT / "backend" / "metro-stations.json",
    ROOT / "backend" / "metro-stations-kazan.json",
]
# Two catalogue places closer than this are the same stop for overlap (way/relation duplicates,
# old automatic walks whose stops carry no placeId).
SAME_POINT_M = 40
# Walking path between stops is longer than the straight line; 1.3 matches central Moscow blocks.
DETOUR = 1.3
V4 = ("elevenlabs", "eleven_v4")
# Measured v4 pace of «Отголосок2» (docs/agents/kazan-walks-2026-10-12.md): ~117 words a minute.
V4_WORDS_PER_MIN = 117


def haversine(a: dict, b: dict) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 6371000 * 2 * math.asin(min(1.0, math.sqrt(h)))


def path_length(points: list[dict]) -> float:
    return sum(haversine(points[i], points[i + 1]) for i in range(len(points) - 1))


def order_route(points: list[dict]) -> list[dict]:
    """Open path: nearest neighbour from each end of the set's diameter, then 2-opt."""
    if len(points) < 3:
        return points
    start = max(points, key=lambda p: max(haversine(p, q) for q in points))
    route, rest = [start], [p for p in points if p is not start]
    while rest:
        nxt = min(rest, key=lambda p: haversine(route[-1], p))
        route.append(nxt)
        rest.remove(nxt)
    improved = True
    while improved:
        improved = False
        for i in range(1, len(route) - 1):
            for j in range(i + 1, len(route)):
                candidate = route[:i] + route[i : j + 1][::-1] + route[j + 1 :]
                if path_length(candidate) + 1e-6 < path_length(route):
                    route, improved = candidate, True
    return route


def load_places(snapshot: dict, include_minor: bool) -> list[dict]:
    """Narrated places, one per audio file: the same MP3 under two ids is one story.

    Plaques, graves and embassies (`kind` from collect.mjs) are left out unless asked for.
    """
    seen: set[str] = set()
    places = []
    for place in snapshot["places"]:
        audio = place.get("audio")
        if not audio or audio["sha256"] in seen:
            continue
        if place.get("kind") and not include_minor:
            continue
        seen.add(audio["sha256"])
        v4 = (audio["provider"], audio["model"]) == V4
        # F5 and v3 are replaced by v4 before publishing, so the walk will sound for the v4 length.
        seconds = (
            audio["durationSec"]
            if v4 or not place.get("words")
            else place["words"] / V4_WORDS_PER_MIN * 60
        )
        places.append({**place, "v4": v4, "seconds": seconds})
    return places


def walk_index(
    snapshot: dict, places: list[dict]
) -> tuple[list[dict], dict[str, set[str]]]:
    """For every promo walk, the set of pool place ids it already uses."""
    by_id = {p["id"]: p for p in snapshot["places"]}
    sha_owner = {p["audio"]["sha256"]: p["id"] for p in places}
    membership: dict[str, set[str]] = {p["id"]: set() for p in places}
    walks = []
    for walk in snapshot["walks"]:
        stops = []
        for stop in walk["stops"]:
            known = by_id.get(stop["placeId"]) if stop["placeId"] else None
            sha = (known or {}).get("audio", {}) or {}
            if sha.get("sha256") in sha_owner:
                stops.append(sha_owner[sha["sha256"]])
            elif stop["lat"] is not None:
                near = [p for p in places if haversine(p, stop) <= SAME_POINT_M]
                if near:
                    stops.append(min(near, key=lambda p: haversine(p, stop))["id"])
        walks.append(
            {
                "id": walk["id"],
                "title": walk["title"],
                "visibility": walk["visibility"],
                "stops": len(walk["stops"]),
                "pool": set(stops),
            }
        )
        for pid in stops:
            membership[pid].add(walk["id"])
    # Duplicate catalogue entries of one building count as used when their twin is.
    for place in places:
        for other in places:
            if (
                other is not place
                and membership[other["id"]]
                and haversine(place, other) <= SAME_POINT_M
            ):
                membership[place["id"]] |= membership[other["id"]]
    return walks, membership


def build_option(
    seed: dict, places: list[dict], membership: dict[str, set[str]], args
) -> dict | None:
    """Grow a set around the seed: new places first, used ones only while every walk stays ≤ the cap."""
    nearby = sorted(
        (p for p in places if haversine(seed, p) <= args.radius_m),
        key=lambda p: haversine(seed, p),
    )
    chosen: list[dict] = []
    for fresh in (True, False):
        for place in nearby:
            if (
                len(chosen) >= args.max_stops
                or place in chosen
                or bool(membership[place["id"]]) == fresh
            ):
                continue
            # A long street or park is split into several OSM objects, each with its own story.
            if any(
                haversine(place, c) <= SAME_POINT_M or c["name"] == place["name"]
                for c in chosen
            ):
                continue
            trial = chosen + [place]
            if not fresh and max_overlap(trial, membership)[0] > args.max_overlap * max(
                len(trial), args.min_stops
            ):
                continue
            chosen = trial
    if len(chosen) < args.min_stops:
        return None
    route = order_route(chosen)
    # Drop the worst detour until hops and length fit; a stop that costs the most distance goes first.
    while len(route) > args.min_stops and (
        path_length(route) * DETOUR > args.max_route_km * 1000
        or max_hop(route) > args.max_hop_m
    ):
        worst = max(
            range(len(route)),
            key=lambda i: path_length(route) - path_length(route[:i] + route[i + 1 :]),
        )
        route = order_route(route[:worst] + route[worst + 1 :])
    if (
        path_length(route) * DETOUR > args.max_route_km * 1000
        or max_hop(route) > args.max_hop_m
    ):
        return None
    audio = sum(p["seconds"] for p in route)
    worst_count, worst_walk = max_overlap(route, membership)
    if audio < args.min_audio_min * 60 or worst_count > args.max_overlap * len(route):
        return None
    return {
        "stops": route,
        "audioSec": audio,
        "worstOverlap": worst_count,
        "worstWalk": worst_walk,
    }


def max_hop(route: list[dict]) -> float:
    return max(
        (haversine(route[i], route[i + 1]) for i in range(len(route) - 1)), default=0
    )


def max_overlap(
    route: list[dict], membership: dict[str, set[str]]
) -> tuple[int, str | None]:
    counts: dict[str, int] = {}
    for place in route:
        for walk in membership[place["id"]]:
            counts[walk] = counts.get(walk, 0) + 1
    if not counts:
        return 0, None
    walk = max(counts, key=counts.get)
    return counts[walk], walk


def nearest_metro(point: dict, stations: list[dict]) -> dict:
    station = min(stations, key=lambda s: haversine(s, point))
    return {"name": station["name"], "distanceM": round(haversine(station, point))}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot")
    parser.add_argument("out_dir")
    parser.add_argument("--min-stops", type=int, default=10)
    parser.add_argument("--max-stops", type=int, default=20)
    parser.add_argument("--min-audio-min", type=float, default=18)
    parser.add_argument("--max-overlap", type=float, default=0.5)
    parser.add_argument("--max-route-km", type=float, default=4)
    parser.add_argument("--max-hop-m", type=float, default=700)
    parser.add_argument("--radius-m", type=float, default=900)
    parser.add_argument("--top", type=int, default=25)
    parser.add_argument("--include-minor", action="store_true")
    args = parser.parse_args()

    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    places = load_places(snapshot, args.include_minor)
    walks, membership = walk_index(snapshot, places)
    titles = {w["id"]: w["title"] for w in walks}
    stations = [
        s
        for f in METRO_FILES
        for s in json.loads(f.read_text(encoding="utf-8"))["stations"]
    ]

    options = [
        o for seed in places if (o := build_option(seed, places, membership, args))
    ]

    # Best first: more new stories, less re-voicing, then more listening time.
    def score(o: dict) -> tuple:
        fresh = sum(1 for p in o["stops"] if not membership[p["id"]])
        v4 = sum(1 for p in o["stops"] if p["v4"])
        return (fresh, v4, o["audioSec"])

    options.sort(key=score, reverse=True)

    # Options must also differ from each other by the same rule as from existing walks.
    accepted: list[dict] = []
    for option in options:
        ids = {p["id"] for p in option["stops"]}
        if all(
            len(ids & {p["id"] for p in a["stops"]}) <= args.max_overlap * len(ids)
            for a in accepted
        ):
            accepted.append(option)
        if len(accepted) >= args.top:
            break

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    result = []
    for n, option in enumerate(accepted, 1):
        stops = option["stops"]
        used = [p for p in stops if membership[p["id"]]]
        result.append(
            {
                "n": n,
                "start": nearest_metro(stops[0], stations),
                "finish": nearest_metro(stops[-1], stations),
                "stops": len(stops),
                "audioMin": round(option["audioSec"] / 60, 1),
                "routeKmEstimate": round(path_length(stops) * DETOUR / 1000, 2),
                "freshStops": len(stops) - len(used),
                "unionOverlapShare": round(len(used) / len(stops), 2),
                "worstOverlap": {
                    "stops": option["worstOverlap"],
                    "walk": titles.get(option["worstWalk"]),
                },
                "needsRevoice": [p["name"] for p in stops if not p["v4"]],
                "points": [
                    {
                        "id": p["id"],
                        "name": p["name"],
                        "storyTitle": p["storyTitle"],
                        "lat": p["lat"],
                        "lon": p["lon"],
                        "audioSec": round(p["seconds"]),
                        "measured": p["v4"],
                        "model": p["audio"]["model"],
                        "kind": p.get("kind"),
                        "inWalks": sorted(titles[w] for w in membership[p["id"]]),
                    }
                    for p in stops
                ],
            }
        )
    (out / "candidates.json").write_text(
        json.dumps(
            {
                "collectedAt": snapshot["collectedAt"],
                "params": vars(args),
                "walks": [{**w, "pool": len(w["pool"])} for w in walks],
                "options": result,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    lines = [
        "| № | Старт → финиш (метро) | Точек | Аудио, мин | Путь, км | Новых | Макс. пересечение | Переозвучка |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in result:
        worst = (
            f"{r['worstOverlap']['stops']} — {r['worstOverlap']['walk']}"
            if r["worstOverlap"]["walk"]
            else "0"
        )
        lines.append(
            f"| {r['n']} | {r['start']['name']} → {r['finish']['name']} | {r['stops']} | {r['audioMin']} | "
            f"{r['routeKmEstimate']} | {r['freshStops']} | {worst} | {len(r['needsRevoice'])} |"
        )
    (out / "candidates.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(
        f"pool={len(places)} walks={len(walks)} options={len(options)} accepted={len(accepted)}"
    )


if __name__ == "__main__":
    main()
