-- Sub-metre tolerance for the zone partition rules.
--
-- The original checks demanded exact geometry: any overlap above ~0.01 m²
-- failed, and two zones only counted as neighbours when their boundaries
-- coincided exactly. Real maps (imported neighbourhood boundaries, hand-drawn
-- edits) routinely carry centimetre-scale slivers, which made otherwise sound
-- maps unplayable -- e.g. a 0.35 m² overlap, or a zone whose border crosses
-- its neighbour's at a shallow angle and so shares only points, not a line.
-- Player location checks already buffer zones by tens of metres, so slivers
-- this thin have no gameplay effect.
--
-- An overlap now counts only if it is still non-empty after shrinking it by
-- 0.5 m (i.e. it is at least ~1 m thick somewhere). Two zones are neighbours if
-- their boundaries coincide exactly (the old rule), or if at least 5 m of one
-- zone's boundary lies within 0.5 m of the other zone.

CREATE OR REPLACE FUNCTION zone_overlap_is_significant(left_geometry geometry, right_geometry geometry)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN NOT (left_geometry && right_geometry) THEN false
    ELSE (
      SELECT CASE
        WHEN ST_Area(overlap.geometry) <= 0.000000000001 THEN false
        ELSE NOT ST_IsEmpty(ST_Buffer(overlap.geometry::geography, -0.5)::geometry)
      END
      FROM (SELECT ST_CollectionExtract(ST_Intersection(left_geometry, right_geometry), 3) AS geometry) overlap
    )
  END;
$$;

CREATE OR REPLACE FUNCTION zones_are_adjacent(left_geometry geometry, right_geometry geometry)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- ~1 m of slack in degrees; the precise test below is in metres.
    WHEN NOT (left_geometry && ST_Expand(right_geometry, 0.00001)) THEN false
    WHEN (
      SELECT ST_Dimension(shared.geometry) = 1 AND ST_Length(shared.geometry) > 0.000000001
      FROM (SELECT ST_Intersection(ST_Boundary(left_geometry), ST_Boundary(right_geometry)) AS geometry) shared
    ) THEN true
    ELSE ST_Length(
      ST_Intersection(
        ST_Boundary(left_geometry),
        ST_Buffer(right_geometry::geography, 0.5)::geometry
      )::geography
    ) >= 5
  END;
$$;

CREATE OR REPLACE FUNCTION map_zone_graph_connected(target_map_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE
  nodes AS (
    SELECT id, geometry
    FROM map_zones
    WHERE map_id = target_map_id
  ),
  edges AS (
    SELECT left_zone.id AS left_id, right_zone.id AS right_id
    FROM nodes left_zone
    JOIN nodes right_zone
      ON left_zone.id < right_zone.id
      AND left_zone.geometry && ST_Expand(right_zone.geometry, 0.00001)
    WHERE zones_are_adjacent(left_zone.geometry, right_zone.geometry)
  ),
  reachable(id) AS (
    (SELECT id FROM nodes ORDER BY id LIMIT 1)
    UNION
    SELECT CASE
      WHEN edges.left_id = reachable.id THEN edges.right_id
      ELSE edges.left_id
    END
    FROM reachable
    JOIN edges ON edges.left_id = reachable.id OR edges.right_id = reachable.id
  )
  SELECT
    (SELECT COUNT(*) FROM nodes) <= 1
    OR (SELECT COUNT(*) FROM reachable) = (SELECT COUNT(*) FROM nodes);
$$;

CREATE OR REPLACE FUNCTION runtime_zone_graph_connected(target_game_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE
  nodes AS (
    SELECT id, geometry
    FROM zones
    WHERE game_id = target_game_id
  ),
  edges AS (
    SELECT left_zone.id AS left_id, right_zone.id AS right_id
    FROM nodes left_zone
    JOIN nodes right_zone
      ON left_zone.id < right_zone.id
      AND left_zone.geometry && ST_Expand(right_zone.geometry, 0.00001)
    WHERE zones_are_adjacent(left_zone.geometry, right_zone.geometry)
  ),
  reachable(id) AS (
    (SELECT id FROM nodes ORDER BY id LIMIT 1)
    UNION
    SELECT CASE
      WHEN edges.left_id = reachable.id THEN edges.right_id
      ELSE edges.left_id
    END
    FROM reachable
    JOIN edges ON edges.left_id = reachable.id OR edges.right_id = reachable.id
  )
  SELECT
    (SELECT COUNT(*) FROM nodes) <= 1
    OR (SELECT COUNT(*) FROM reachable) = (SELECT COUNT(*) FROM nodes);
$$;

CREATE OR REPLACE FUNCTION map_zone_partition_has_no_overlaps(target_map_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM map_zones left_zone
    JOIN map_zones right_zone
      ON left_zone.map_id = right_zone.map_id
      AND left_zone.id < right_zone.id
      AND left_zone.geometry && right_zone.geometry
    WHERE left_zone.map_id = target_map_id
      AND zone_overlap_is_significant(left_zone.geometry, right_zone.geometry)
  );
$$;

CREATE OR REPLACE FUNCTION runtime_zone_partition_has_no_overlaps(target_game_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM zones left_zone
    JOIN zones right_zone
      ON left_zone.game_id = right_zone.game_id
      AND left_zone.id < right_zone.id
      AND left_zone.geometry && right_zone.geometry
    WHERE left_zone.game_id = target_game_id
      AND zone_overlap_is_significant(left_zone.geometry, right_zone.geometry)
  );
$$;
