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
      AND left_zone.geometry && right_zone.geometry
    CROSS JOIN LATERAL (
      SELECT ST_Intersection(
        ST_Boundary(left_zone.geometry),
        ST_Boundary(right_zone.geometry)
      ) AS geometry
    ) shared_boundary
    WHERE ST_Dimension(shared_boundary.geometry) = 1
      AND ST_Length(shared_boundary.geometry) > 0.000000001
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
      AND left_zone.geometry && right_zone.geometry
    CROSS JOIN LATERAL (
      SELECT ST_Intersection(
        ST_Boundary(left_zone.geometry),
        ST_Boundary(right_zone.geometry)
      ) AS geometry
    ) shared_boundary
    WHERE ST_Dimension(shared_boundary.geometry) = 1
      AND ST_Length(shared_boundary.geometry) > 0.000000001
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
      AND ST_Area(ST_Intersection(left_zone.geometry, right_zone.geometry)) > 0.000000000001
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
      AND ST_Area(ST_Intersection(left_zone.geometry, right_zone.geometry)) > 0.000000000001
  );
$$;

CREATE OR REPLACE FUNCTION enforce_runtime_zones_connected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_game_id uuid;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.game_id IS NOT DISTINCT FROM NEW.game_id
    AND OLD.geometry IS NOT DISTINCT FROM NEW.geometry THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.game_id IS DISTINCT FROM NEW.game_id THEN
    IF NOT runtime_zone_graph_connected(OLD.game_id)
      OR NOT runtime_zone_partition_has_no_overlaps(OLD.game_id) THEN
      RAISE EXCEPTION 'Runtime zones must form one connected, non-overlapping partition.'
        USING ERRCODE = '23514', CONSTRAINT = 'zones_connected';
    END IF;
  END IF;

  target_game_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.game_id ELSE NEW.game_id END;
  IF NOT runtime_zone_graph_connected(target_game_id)
    OR NOT runtime_zone_partition_has_no_overlaps(target_game_id) THEN
    RAISE EXCEPTION 'Runtime zones must form one connected, non-overlapping partition.'
      USING ERRCODE = '23514', CONSTRAINT = 'zones_connected';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_runtime_zones_connected_after_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_game_id uuid;
BEGIN
  FOR target_game_id IN SELECT DISTINCT game_id FROM inserted_zones LOOP
    IF NOT runtime_zone_graph_connected(target_game_id)
      OR NOT runtime_zone_partition_has_no_overlaps(target_game_id) THEN
      RAISE EXCEPTION 'Runtime zones must form one connected, non-overlapping partition.'
        USING ERRCODE = '23514', CONSTRAINT = 'zones_connected';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zones_connected ON zones;
DROP TRIGGER IF EXISTS zones_connected_after_insert ON zones;

CREATE TRIGGER zones_connected_after_insert
AFTER INSERT ON zones
REFERENCING NEW TABLE AS inserted_zones
FOR EACH STATEMENT
EXECUTE FUNCTION enforce_runtime_zones_connected_after_insert();

CREATE CONSTRAINT TRIGGER zones_connected
AFTER UPDATE OR DELETE ON zones
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_runtime_zones_connected();
