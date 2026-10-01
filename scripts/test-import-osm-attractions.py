import importlib.util
import pathlib
import unittest

PATH=pathlib.Path(__file__).with_name("import-osm-attractions.py")
SPEC=importlib.util.spec_from_file_location("osm_import",PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class ImporterTest(unittest.TestCase):
    def test_rules_include_addressless_attractions(self):
        self.assertEqual(MODULE.selected({"name":"Парк","leisure":"park"})["leisure"],"park")
        self.assertEqual(MODULE.selected({"name":"Дом","building":"yes","architect":"Автор"})["building"],"yes")
        self.assertIsNone(MODULE.selected({"name":"Дом","building":"yes"}))
    def test_preserves_city_without_requiring_a_street_address(self):
        for city in ("Москва", "", None):
            with self.subTest(city=city):
                tags=MODULE.selected({"name":"Парк","leisure":"park","addr:city":city})
                self.assertIsNotNone(tags)
                if city:
                    self.assertEqual(tags["addr:city"],city)
                else:
                    self.assertNotIn("addr:city",tags)
                self.assertNotIn("addr:street",tags)
    def test_duplicate_candidates_are_conservative(self):
        items=[{"placeId":"osm:node:1","name":"Памятник","location":{"lat":55.75,"lon":37.61},"tags":{"wikidata":"Q1"}},
               {"placeId":"osm:way:2","name":"памятник","location":{"lat":55.75001,"lon":37.61001},"tags":{"wikidata":"Q1"}}]
        self.assertEqual({item["reason"] for item in MODULE.duplicate_candidates(items)},{"wikidata","nearby_name"})
    def test_boundary_excludes_holes_and_outside_points(self):
        geometry={"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[6,4],[6,6],[4,6],[4,4]]]}
        self.assertTrue(MODULE.point_in_geometry({"lat":2,"lon":2},geometry))
        self.assertFalse(MODULE.point_in_geometry({"lat":5,"lon":5},geometry))
        self.assertFalse(MODULE.point_in_geometry({"lat":20,"lon":20},geometry))
    def test_representative_point_lies_on_geometry(self):
        points=[(55.0,37.0),(55.2,37.4),(55.4,37.1),(55.0,37.0)]
        point=MODULE.representative_point(points)
        left,right=points[1],points[2]
        self.assertEqual(point,{"lat":round((left[0]+right[0])/2,7),"lon":round((left[1]+right[1])/2,7)})
    def test_complete_geometry_must_be_inside_boundary(self):
        boundary={"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]]]}
        self.assertTrue(MODULE.geometry_covered({"type":"LineString","coordinates":[[1,1],[9,9]]},boundary))
        self.assertFalse(MODULE.geometry_covered({"type":"LineString","coordinates":[[1,1],[11,9]]},boundary))
    def test_relation_geometry_preserves_outer_rings_and_holes(self):
        geometry=MODULE.polygon_geometry([[[(0,0),(0,10),(10,10),(10,0),(0,0)],[(4,4),(4,6),(6,6),(6,4),(4,4)]],
                                          [[(20,20),(20,21),(21,21),(21,20),(20,20)]]])
        self.assertEqual(geometry["type"],"MultiPolygon")
        self.assertEqual(len(geometry["coordinates"][0]),2)
        boundary={"type":"Polygon","coordinates":[[[-1,-1],[30,-1],[30,30],[-1,30],[-1,-1]]]}
        self.assertTrue(MODULE.geometry_covered(geometry,boundary))
    def test_verified_boundary_relation_version_is_recorded(self):
        handler=MODULE.Attractions(102269)
        class Timestamp:
            @staticmethod
            def isoformat(): return "2026-09-16T00:00:00+00:00"
        relation=type("Relation",(),{"id":102269,"version":42,"timestamp":Timestamp()})()
        handler.relation(relation);self.assertEqual(handler.boundary_version["version"],42)

if __name__=="__main__":unittest.main()
