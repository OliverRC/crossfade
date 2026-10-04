-- Backfill from the Tidal tracks earlier pulls saved: songs first seen on Tidal were stored without their version tag.
CREATE TEMP TABLE tidal_versions AS
  SELECT json_extract(t.value, '$.providerTrackId') AS track_id, max(json_extract(t.value, '$.version')) AS version
  FROM fetch_checkpoints fc, json_each(fc.tracks) t
  WHERE fc.provider = 'tidal' AND coalesce(json_extract(t.value, '$.version'), '') <> ''
  GROUP BY 1;
--> statement-breakpoint
UPDATE canonical_tracks SET version = (
  SELECT tv.version FROM track_links tl JOIN tidal_versions tv ON tv.track_id = tl.provider_track_id
  WHERE tl.canonical_track_id = canonical_tracks.id AND tl.provider = 'tidal' AND tl.method = 'origin'
)
WHERE id IN (SELECT canonical_track_id FROM track_links WHERE provider = 'tidal' AND method = 'origin');
--> statement-breakpoint
DROP TABLE tidal_versions;
