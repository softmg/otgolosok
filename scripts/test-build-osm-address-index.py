import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "address_index", Path(__file__).with_name("build-osm-address-index.py")
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AddressIndexTest(unittest.TestCase):
    def test_index_imports_ordinary_unnamed_addresses_and_streets(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "fixture.osm"
            output = Path(directory) / "index.sqlite"
            source.write_text(
                """<osm version="0.6">
              <node id="1" lat="55.75" lon="37.61" version="1" timestamp="2026-09-01T00:00:00Z"><tag k="addr:street" v="Тестовая улица"/><tag k="addr:housenumber" v="1"/></node>
              <node id="2" lat="55.75" lon="37.62" version="1"/>
              <node id="3" lat="55.76" lon="37.62" version="1"/>
              <node id="4" lat="55.76" lon="37.61" version="1"/>
              <way id="1" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/><tag k="addr:street" v="Тестовая улица"/><tag k="addr:housenumber" v="2"/></way>
              <way id="2" version="1"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Тестовая улица"/></way>
            </osm>""",
                encoding="utf-8",
            )
            result = MODULE.build(source, output, "fixture")
            self.assertEqual(
                result["counts"], {"address": 1, "street": 1, "building": 1}
            )
            with sqlite3.connect(output) as db:
                self.assertEqual(
                    db.execute("SELECT count(*) FROM bounds").fetchone()[0], 3
                )
                row = db.execute(
                    "SELECT address,geometry FROM features WHERE kind='building'"
                ).fetchone()
                self.assertEqual(row[0], "Москва, Тестовая улица, 2")
                self.assertEqual(json.loads(row[1])["type"], "MultiPolygon")

    def test_failed_empty_import_preserves_previous_index(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "empty.osm"
            source.write_text('<osm version="0.6"></osm>', encoding="utf-8")
            output = Path(directory) / "index.sqlite"
            output.write_bytes(b"existing-index")
            with self.assertRaisesRegex(ValueError, "прежний индекс сохранён"):
                MODULE.build(source, output)
            self.assertEqual(output.read_bytes(), b"existing-index")
            self.assertEqual(list(Path(directory).glob(".osm-addresses-*")), [])

    def test_relation_preserves_courtyard_hole(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "relation.osm"
            output = Path(directory) / "index.sqlite"
            points = [
                (37.60, 55.74),
                (37.62, 55.74),
                (37.62, 55.76),
                (37.60, 55.76),
                (37.609, 55.749),
                (37.611, 55.749),
                (37.611, 55.751),
                (37.609, 55.751),
            ]
            nodes = "".join(
                f'<node id="{i}" lon="{lon}" lat="{lat}" version="1"/>'
                for i, (lon, lat) in enumerate(points, 1)
            )
            source.write_text(
                '<osm version="0.6">'
                + nodes
                + """
              <way id="1" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/></way>
              <way id="2" version="1"><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/></way>
              <relation id="1" version="1"><member type="way" ref="1" role="outer"/><member type="way" ref="2" role="inner"/>
                <tag k="type" v="multipolygon"/><tag k="building" v="yes"/><tag k="addr:street" v="Улица"/><tag k="addr:housenumber" v="1"/>
              </relation></osm>""",
                encoding="utf-8",
            )
            MODULE.build(source, output)
            with sqlite3.connect(output) as db:
                osm_id, geometry = db.execute(
                    "SELECT osm_id,geometry FROM features"
                ).fetchone()
                self.assertEqual(osm_id, "osm:relation:1")
                self.assertEqual(len(json.loads(geometry)["coordinates"][0]), 2)

    def test_partial_addresses_do_not_turn_into_full_addresses(self):
        self.assertIsNone(MODULE.postal_address({"addr:street": "Улица"}))
        self.assertIsNone(MODULE.postal_address({"addr:housenumber": "1"}))
        self.assertEqual(
            MODULE.postal_address({"addr:full": "Собственный адрес"}),
            "Собственный адрес",
        )
        self.assertIsNone(MODULE.feature_kind({"name": "Магазин"}))
        self.assertEqual(
            MODULE.feature_kind(
                {"name": "Район", "boundary": "administrative", "admin_level": "8"},
                area=True,
            ),
            "district",
        )


if __name__ == "__main__":
    unittest.main()
