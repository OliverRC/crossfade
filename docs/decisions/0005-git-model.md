# 0005 Pull, main and push: the git model

Date: 2026-10-03 · Milestones: M4 onwards

The plan bundles everything under "Sync": read both services, match, diff, plan, then Apply. In practice reading and writing are separate jobs with different costs and risks. Reading Tidal costs nothing scarce. Spotify lookups are rationed by an unpublished quota. Writes change a real library. After the Tidal cleanup (0004) there was no way to re-read only Tidal. Oliver is a developer and the app is for him, so the design borrows git's architecture outright. It stays a web app: git shapes the model and the words, not a command line.

## The model

| git | Crossfade |
| --- | --- |
| `main` | The canonical library on the machine: every song, which playlists it belongs in, and its state on each service |
| remotes | `spotify` and `tidal`, equal peers; neither is the origin |
| remote-tracking branch | The last snapshot read from each service (`spotify/main`, `tidal/main`) |
| `pull spotify` | Read Spotify, work out what changed since its last snapshot, and apply those changes to main. Never writes to either service |
| `push tidal` | Make Tidal match main: show what will be added and removed, then write it when Oliver presses Push |
| `status` | Per playlist and service: what the service is missing compared with main (to push), and what main has not taken from it yet (to pull) |
| merge conflict | A pull that would undo something main changed after that service's last snapshot, such as removing a song the other service just added. The pull stops on that song and asks |
| `--force-with-lease` | Push re-reads the playlist before writing and writes only what is still needed |
| `log` | The Activity page: every pull and push with what it changed |

## Rules

- **Pull only reads and changes main.** Adds and removals on a service since its last snapshot become adds and removals in main. The plan's diff table still holds, read one service at a time: "absent → present" is an add, "present → absent" a removal, and a removal that meets a newer change in main is a conflict.
- **Pull keeps the sanity guard.** If a playlist comes back empty, or would lose more than 10% of its songs (at least 5), that playlist is not merged. It is flagged instead, so a bad read never looks like a mass deletion.
- **The first pull of each service fills main with everything from it.** Two first pulls give the union of both libraries, as the V0 dry run already shows.
- **Push is the only code path that writes to Spotify or Tidal.** It always shows its changes first, removals listed separately, and writes only when Oliver presses Push. Changes Oliver holds back stay held back and are not asked about again. (Superseded by 0007: push sends only what Oliver staged, so nothing needs holding back.)
- **Matching moves to push.** A pull can tell what a service is missing by comparing ISRCs in memory, which is free. Finding a song's ID on the target service is only needed when pushing it, so Spotify's rationed lookups are spent only on songs being pushed. A push that runs out of lookups stops partway and resumes; Tidal can be pushed meanwhile.
- **Songs a service no longer offers stay in main**, marked unavailable there. Push skips them, and they go back in if the service brings them back (the cleanup already records these, 0004).
- **One service at a time is the normal case.** Pull Tidal, pull Spotify, push Tidal and push Spotify are four separate buttons.

## Push buttons

The push button follows where changes are waiting to go. A song added on Spotify is pulled into main and then waits for Tidal.

| Changes waiting for | Button |
| --- | --- |
| Spotify only | **Push to Spotify** |
| Tidal only | **Push to Tidal** |
| Both | **Push to both**, a split button whose menu offers Push to Spotify and Push to Tidal |
| Neither | No push button; the status shows both services match main |

Each button shows its count, for example "Push to Tidal · 12", and every push opens the preview first, with removals listed separately. Push to both is still one manual press with a preview for each service, so it is not the automatic sync deferred below. The same buttons appear per playlist and for the whole library.

## Sync comes later

A one-press "sync" that pulls both services and pushes to both waits until pull and push have earned trust on the real library. Until then there is no automatic push, and nothing is written without Oliver seeing it first. Scheduled pulls are safe, because a pull never writes to a service.

## Implementation notes (M4)

- Main is `memberships` (active, or removed as a tombstone), with `changed_at` and `changed_by` (a service or `user`). Each service has one row in `snapshots` per collection: the base its next pull compares against.
- A pull that finds a song newly added on a service when main already has it records a **confirm** by that service. That is what turns "removed on Spotify, added on Tidal" into a conflict instead of a silent removal. A first pull confirms nothing, so setting up main raises no conflicts.
- Tidal reads list items without a country code and keep songs Tidal will not play in Oliver's country, marked unavailable (in one checked playlist, 7 of 125). Before this, those songs silently dropped out of the read, and a pull would have treated them as removed.
- A playlist that disappears from a service is held as **gone**. Oliver chooses to keep it in main (push would recreate it there) or remove its songs from main.
- Held collections and conflicts are decided on the Library page; the decisions are stored as changes by `user`.
- The V0 dry-run sync, its lookup stage and its diff are gone (commit `083c0c4` has them). Lookups return with push.

## What this replaces

- The plan's Sync, queue and Apply become pull, main and push. The persistent queue becomes "changes not pushed yet": it is derived from main and each service's snapshot, and stored decisions such as held-back changes are kept.
- `sync_runs` and the fetch checkpoints from 0003 become the pull's checkpointed read. Lookup rationing and pausing move from the read to push.
- Milestones, replacing M4 and M5:
  - **M4 Main and pull.** Memberships in main, a snapshot per service, pull per service with merge, conflicts and the sanity guard, and a status view. Done when pulling Tidal then Spotify builds a main Oliver agrees with, the status view shows what each service is missing, and pulling again with nothing changed reports nothing new.
  - **M5 Push.** Preview per service, hold back, ID lookup at push time, fresh read before writing, per-song results and failure states. Done when a song added on Spotify reaches Tidal after pull Spotify and push Tidal, a removal does the same, and a forced failure shows and then clears on retry.
  - **M3 Manual search and review** moves after M5. Unmatched songs and fuzzy candidates now surface during push, which is where reviewing them belongs.
  - **M6 Automation** gains sync (pull both, push both) once pull and push are trusted, scheduled pulls, and the re-check of pulled songs.
- The playlist cleanup (0004) stays a separate maintenance tool that writes to Tidal directly, like `git gc`. When push exists, cleanup writes should go through the same write path.
