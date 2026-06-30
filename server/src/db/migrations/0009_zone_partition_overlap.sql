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
    WHERE left_zone.game_id = target_game_id
      AND ST_Area(ST_Intersection(left_zone.geometry, right_zone.geometry)) > 0.000000000001
  );
$$;

CREATE OR REPLACE FUNCTION enforce_map_zones_connected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_map_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.map_id IS DISTINCT FROM NEW.map_id THEN
    IF NOT map_zone_graph_connected(OLD.map_id)
      OR NOT map_zone_partition_has_no_overlaps(OLD.map_id) THEN
      RAISE EXCEPTION 'Authored zones must form one connected, non-overlapping partition.'
        USING ERRCODE = '23514', CONSTRAINT = 'map_zones_connected';
    END IF;
  END IF;

  target_map_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.map_id ELSE NEW.map_id END;
  IF NOT map_zone_graph_connected(target_map_id)
    OR NOT map_zone_partition_has_no_overlaps(target_map_id) THEN
    RAISE EXCEPTION 'Authored zones must form one connected, non-overlapping partition.'
      USING ERRCODE = '23514', CONSTRAINT = 'map_zones_connected';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_runtime_zones_connected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_game_id uuid;
BEGIN
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
