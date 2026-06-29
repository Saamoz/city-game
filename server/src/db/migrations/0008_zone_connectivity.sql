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
    JOIN nodes right_zone ON left_zone.id < right_zone.id
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
    JOIN nodes right_zone ON left_zone.id < right_zone.id
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

CREATE OR REPLACE FUNCTION enforce_map_zones_connected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.map_id IS DISTINCT FROM NEW.map_id THEN
    IF NOT map_zone_graph_connected(OLD.map_id) THEN
      RAISE EXCEPTION 'Authored zones must form one connected boundary graph.'
        USING ERRCODE = '23514', CONSTRAINT = 'map_zones_connected';
    END IF;
  END IF;

  IF NOT map_zone_graph_connected(CASE WHEN TG_OP = 'DELETE' THEN OLD.map_id ELSE NEW.map_id END) THEN
    RAISE EXCEPTION 'Authored zones must form one connected boundary graph.'
      USING ERRCODE = '23514', CONSTRAINT = 'map_zones_connected';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_runtime_zones_connected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.game_id IS DISTINCT FROM NEW.game_id THEN
    IF NOT runtime_zone_graph_connected(OLD.game_id) THEN
      RAISE EXCEPTION 'Runtime zones must form one connected boundary graph.'
        USING ERRCODE = '23514', CONSTRAINT = 'zones_connected';
    END IF;
  END IF;

  IF NOT runtime_zone_graph_connected(CASE WHEN TG_OP = 'DELETE' THEN OLD.game_id ELSE NEW.game_id END) THEN
    RAISE EXCEPTION 'Runtime zones must form one connected boundary graph.'
      USING ERRCODE = '23514', CONSTRAINT = 'zones_connected';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER map_zones_connected
AFTER INSERT OR UPDATE OR DELETE ON map_zones
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_map_zones_connected();

CREATE CONSTRAINT TRIGGER zones_connected
AFTER INSERT OR UPDATE OR DELETE ON zones
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_runtime_zones_connected();
