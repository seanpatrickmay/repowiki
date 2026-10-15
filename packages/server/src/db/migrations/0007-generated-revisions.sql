-- ADR-0012: a revision holds its generation's content; authors edit nothing. A revision stored
-- with author overrides (M14g local runs) is rewritten from its generation: the suggested tagline
-- and summary, the model's contribution draft or else the facts paragraph (without "most of
-- all", whose feature titles live in the export), and no highlights. Its review and preview were
-- of the author's text, so they go.
DELETE FROM reviews r
USING revisions v
WHERE r.project_id = v.project_id AND r.revision = v.number AND v.body ? 'overrides';

DELETE FROM previews p
USING revisions v
WHERE p.project_id = v.project_id AND p.revision = v.number AND v.body ? 'overrides';

WITH legacy AS (
  SELECT
    v.project_id,
    v.number,
    g.body -> 'suggestions' AS s,
    g.body -> 'facts' -> 'author' AS a,
    a.body ->> 'displayName' AS name
  FROM revisions v
  JOIN generations g ON g.id = (v.body ->> 'generationId')::uuid
  JOIN projects p ON p.id = v.project_id
  JOIN accounts a ON a.id = p.account_id
  WHERE v.body ? 'overrides'
),
written AS (
  SELECT
    project_id,
    number,
    s,
    CASE
      WHEN btrim(s ->> 'contributionDraft') <> '' THEN btrim(s ->> 'contributionDraft')
      WHEN (a ->> 'commits')::int = 0 THEN format(
        'The git history at this commit attributes none of the repository''s %s %s to %s.',
        a ->> 'totalCommits',
        CASE WHEN (a ->> 'totalCommits')::int = 1 THEN 'commit' ELSE 'commits' END,
        name)
      ELSE format(
        '%s wrote %s of the repository''s %s %s%s.',
        name,
        a ->> 'commits',
        a ->> 'totalCommits',
        CASE WHEN (a ->> 'totalCommits')::int = 1 THEN 'commit' ELSE 'commits' END,
        CASE
          WHEN (a ->> 'totalLines')::int = 0 THEN ''
          WHEN round((a ->> 'currentLines')::numeric * 100 / (a ->> 'totalLines')::numeric) = 0
            AND (a ->> 'currentLines')::int > 0 THEN ' and about under 1% of its current lines'
          ELSE format(' and about %s%% of its current lines',
            round((a ->> 'currentLines')::numeric * 100 / (a ->> 'totalLines')::numeric))
        END)
    END AS contribution
  FROM legacy
)
UPDATE revisions v
SET body = jsonb_build_object(
  'projectId', v.body -> 'projectId',
  'number', v.body -> 'number',
  'generationId', v.body -> 'generationId',
  'content', jsonb_build_object(
    'tagline', w.s -> 'tagline',
    'summary', w.s -> 'summary',
    'contribution', to_jsonb(w.contribution),
    'highlights', '[]'::jsonb
  ),
  'createdAt', v.body -> 'createdAt'
)
FROM written w
WHERE v.project_id = w.project_id AND v.number = w.number;
