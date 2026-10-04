-- Backfill each link's own copy (ISRC, title, album) from the tracks earlier pulls saved, newest fetch first.
CREATE TEMP TABLE fetched_copies AS
  SELECT provider, track_id, isrc, title, album FROM (
    SELECT fc.provider, json_extract(t.value, '$.providerTrackId') AS track_id, json_extract(t.value, '$.isrc') AS isrc,
      json_extract(t.value, '$.title') AS title, json_extract(t.value, '$.album') AS album,
      row_number() OVER (PARTITION BY fc.provider, json_extract(t.value, '$.providerTrackId') ORDER BY fc.fetched_at DESC) AS n
    FROM fetch_checkpoints fc, json_each(fc.tracks) t
  ) WHERE n = 1;
--> statement-breakpoint
CREATE INDEX fetched_copies_track ON fetched_copies (provider, track_id);
--> statement-breakpoint
UPDATE track_links SET
  isrc = (SELECT f.isrc FROM fetched_copies f WHERE f.provider = track_links.provider AND f.track_id = track_links.provider_track_id),
  title = (SELECT f.title FROM fetched_copies f WHERE f.provider = track_links.provider AND f.track_id = track_links.provider_track_id),
  album = (SELECT f.album FROM fetched_copies f WHERE f.provider = track_links.provider AND f.track_id = track_links.provider_track_id)
WHERE provider_track_id IS NOT NULL;
--> statement-breakpoint
-- A link push found by ISRC, never fetched by a pull, has the song's ISRC.
UPDATE track_links SET isrc = (SELECT c.isrc FROM canonical_tracks c WHERE c.id = track_links.canonical_track_id)
WHERE isrc IS NULL AND method = 'isrc' AND provider_track_id IS NOT NULL;
--> statement-breakpoint
DROP TABLE fetched_copies;
