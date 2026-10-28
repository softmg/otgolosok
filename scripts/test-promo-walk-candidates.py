import argparse
import importlib.util
import json
import pathlib
import tempfile
import unittest

PATH = pathlib.Path(__file__).parents[1] / ".claude" / "skills" / "promo-walk-candidates" / "scripts" / "analyze.py"
SPEC = importlib.util.spec_from_file_location("promo_walk_candidates", PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

# One degree of latitude is ~111 km: 0.0005° ≈ 56 m, 0.002° ≈ 222 m.
BASE_LAT, BASE_LON = 55.75, 37.62


def place(i: int, lat: float, lon: float = BASE_LON) -> dict:
    return {"id": f"osm:node:{i}", "name": f"Точка {i}", "storyTitle": f"Точка {i}", "lat": lat, "lon": lon,
            "kind": None, "photo": True, "words": 120,
            "audio": {"sha256": f"{i:064x}", "durationSec": 120.0, "provider": "elevenlabs", "model": "eleven_v4"}}


def args(**overrides) -> argparse.Namespace:
    values = {"min_stops": 10, "max_stops": 20, "min_audio_min": 18, "max_overlap": 0.5, "near_m": 100,
              "max_near_overlap": 0.5, "max_route_km": 10, "max_hop_m": 700, "radius_m": 3000}
    return argparse.Namespace(**(values | overrides))


def street(count: int, step: float = 0.002) -> list[dict]:
    """Places along a line, ~222 m apart: a walk can join them all."""
    return [place(i, BASE_LAT + i * step) for i in range(count)]


def walk(stops: list[tuple[float, float]], walk_id: str = "w1") -> dict:
    return {"id": walk_id, "title": walk_id, "visibility": "public",
            "stops": [{"placeId": None, "lat": lat, "lon": lon} for lat, lon in stops]}


class NearIndexTest(unittest.TestCase):
    def test_stop_within_radius_marks_place_and_farther_does_not(self):
        places = MODULE.load_places({"places": [place(1, BASE_LAT), place(2, BASE_LAT + 0.002)]}, False)
        snapshot = {"walks": [walk([(BASE_LAT + 0.0005, BASE_LON)])]}
        near = MODULE.near_index(snapshot, places, 100)
        self.assertEqual(near, {"osm:node:1": {"w1"}, "osm:node:2": set()})

    def test_radius_boundary_is_inclusive(self):
        places = MODULE.load_places({"places": [place(1, BASE_LAT)]}, False)
        stop = {"lat": BASE_LAT + 0.0009, "lon": BASE_LON}
        distance = MODULE.haversine(places[0], stop)
        for radius, expected in ((distance, {"w1"}), (distance - 1, set())):
            with self.subTest(radius=radius):
                near = MODULE.near_index({"walks": [walk([(stop["lat"], stop["lon"])])]}, places, radius)
                self.assertEqual(near["osm:node:1"], expected)

    def test_stops_without_coordinates_are_ignored(self):
        places = MODULE.load_places({"places": [place(1, BASE_LAT)]}, False)
        snapshot = {"walks": [{"id": "w1", "stops": [{"placeId": None, "lat": None, "lon": None}]}]}
        self.assertEqual(MODULE.near_index(snapshot, places, 100), {"osm:node:1": set()})


class BuildOptionNearOverlapTest(unittest.TestCase):
    def build(self, walk_stops: list[tuple[float, float]], **overrides):
        snapshot = {"places": street(12), "walks": [walk(walk_stops)]}
        places = MODULE.load_places(snapshot, False)
        _, membership = MODULE.walk_index(snapshot, places)
        near = MODULE.near_index(snapshot, places, 100)
        return MODULE.build_option(places[0], places, membership, near, args(**overrides))

    def test_area_without_other_walks_is_accepted(self):
        option = self.build([])
        assert option is not None
        self.assertEqual((len(option["stops"]), option["nearOverlap"], option["nearWalk"]), (12, 0, None))

    def test_same_street_as_a_walk_is_rejected_though_no_place_is_shared(self):
        # Another walk's stops 60 m off every place: different stories, the same street.
        option = self.build([(BASE_LAT + i * 0.002 + 0.00055, BASE_LON) for i in range(12)])
        self.assertIsNone(option)

    def test_near_stops_up_to_the_cap_are_allowed(self):
        # Five of twelve places (≤ 50 %) stand next to the walk; the walk still passes.
        option = self.build([(BASE_LAT + i * 0.002 + 0.00055, BASE_LON) for i in range(5)])
        assert option is not None
        self.assertEqual((option["nearOverlap"], option["nearWalk"]), (5, "w1"))

    def test_stricter_cap_leaves_out_near_places_while_the_rest_still_make_a_walk(self):
        stops = [(BASE_LAT + i * 0.002 + 0.00055, BASE_LON) for i in range(5)]
        option = self.build(stops, max_near_overlap=0.3)
        assert option is not None
        self.assertEqual((len(option["stops"]), option["nearOverlap"]), (10, 3))
        self.assertIsNone(self.build(stops, max_near_overlap=0.3, min_stops=11))


class ExtraWalksTest(unittest.TestCase):
    def test_local_walk_stops_files_join_the_snapshot_walks(self):
        stops = [{"placeId": "osm:node:1", "location": {"lat": BASE_LAT, "lon": BASE_LON}, "label": "точка"},
                 {"placeId": None, "lat": BASE_LAT + 0.001, "lon": BASE_LON}]
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "pack" / "walk-stops-x.json"
            path.parent.mkdir()
            path.write_text(json.dumps(stops), encoding="utf-8")
            (extra,) = MODULE.load_extra_walks([str(path)])
        self.assertEqual(extra["title"], "pack/walk-stops-x (локальный пакет)")
        self.assertEqual(extra["stops"], [{"placeId": "osm:node:1", "lat": BASE_LAT, "lon": BASE_LON},
                                          {"placeId": None, "lat": BASE_LAT + 0.001, "lon": BASE_LON}])

    def test_no_files_add_no_walks(self):
        self.assertEqual(MODULE.load_extra_walks([]), [])


if __name__ == "__main__":
    unittest.main()
