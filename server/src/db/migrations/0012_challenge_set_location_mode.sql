UPDATE challenge_sets AS challenge_set
SET metadata = jsonb_set(
  challenge_set.metadata,
  '{locationMode}',
  to_jsonb(CASE
    WHEN EXISTS (SELECT 1 FROM challenge_set_items AS item WHERE item.set_id = challenge_set.id AND item.config->>'location_mode' = 'point') THEN 'point'::text
    WHEN EXISTS (SELECT 1 FROM challenge_set_items AS item WHERE item.set_id = challenge_set.id AND item.map_zone_id IS NOT NULL) THEN 'zone'::text
    ELSE 'portable'::text
  END),
  true
)
WHERE NOT (challenge_set.metadata ? 'locationMode');
