-- ADR-0013: a revision's content is its contribution only; the project page that showed its
-- tagline, summary and highlights is gone. A review attested to the longer content, so the
-- review of a rewritten revision goes.
DELETE FROM reviews r
USING revisions v
WHERE r.project_id = v.project_id AND r.revision = v.number
  AND (v.body -> 'content') - 'contribution' <> '{}'::jsonb;

UPDATE revisions
SET body = jsonb_set(
  body, '{content}', jsonb_build_object('contribution', body -> 'content' -> 'contribution')
)
WHERE (body -> 'content') - 'contribution' <> '{}'::jsonb;
