-- ADR-0012: reviews attest to version 2, an author approving generated content. A version 1
-- review attested to text the author wrote, so it no longer counts; the author reviews again.
DELETE FROM reviews WHERE body ->> 'attestationVersion' = '1';
