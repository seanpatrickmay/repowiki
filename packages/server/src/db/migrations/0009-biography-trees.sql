-- ADR-0013: a preview or version tree now holds the wiki under site/, built at the project's own
-- path, and the project's biography entry. Trees stored before hold neither and cannot be rebuilt
-- here, so their previews and preview links go, and every published project returns to draft
-- (its versions kept) until its author previews and publishes it again. So does a project
-- withdrawn for its repository with a version, which restoring would otherwise publish again on
-- an old tree.
DELETE FROM preview_tokens;
DELETE FROM previews;
UPDATE projects
SET body = jsonb_set(body, '{state}', '"draft"')
WHERE body ->> 'state' = 'published';

UPDATE projects
SET body = body || '{"state":"draft","withdrawReason":null,"withdrawnAt":null,"unavailableSince":null}'::jsonb
WHERE body ->> 'state' = 'withdrawn'
  AND body ->> 'withdrawReason' = 'repository'
  AND (body ->> 'currentVersion')::int > 0;
