-- ADR-0012: every wiki page is public. A revision that hid features loses them, and its review and
-- preview go with them, since both were made of a wiki without those pages.
DELETE FROM reviews r
USING revisions v
WHERE r.project_id = v.project_id
  AND r.revision = v.number
  AND jsonb_array_length(coalesce(v.body -> 'overrides' -> 'hiddenFeatureIds', '[]'::jsonb)) > 0;

DELETE FROM previews p
USING revisions v
WHERE p.project_id = v.project_id
  AND p.revision = v.number
  AND jsonb_array_length(coalesce(v.body -> 'overrides' -> 'hiddenFeatureIds', '[]'::jsonb)) > 0;

UPDATE revisions
SET body = jsonb_set(
  body #- '{overrides,hiddenFeatureIds}',
  '{flags}',
  coalesce(
    (SELECT jsonb_agg(f) FROM jsonb_array_elements(body -> 'flags') AS f
     WHERE f #>> '{}' NOT LIKE 'hidden-missing:%'),
    '[]'::jsonb
  )
)
WHERE body -> 'overrides' ? 'hiddenFeatureIds';
