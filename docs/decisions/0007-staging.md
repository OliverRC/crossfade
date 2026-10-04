# 0007 Staging: pick what each push carries

Date: 2026-10-04 · Milestone: M5

Decision 0005 had push carry every change waiting for a service, with Oliver able to hold back the ones he did not want. With libraries this far apart (about 6,500 Tidal songs against 720 on Spotify), almost everything is waiting, and holding back thousands of songs to push a dozen is the wrong way round. Oliver wants to pick changes in the Library and push what he picked.

The git word for that is staging (`git add`), not stashing: `git stash` shelves changes out of the way, the staging area is what goes out next. Crossfade has no commit step, so a push sends what is staged straight to the service.

| git | Crossfade |
| --- | --- |
| working tree changes | The changes a push would make: derived from main and each service's snapshot, as before |
| `git add` | Stage a change: one song on one service, a whole collection, or everything for a service |
| the index | The staged changes for each service, shown on the Staged page |
| `git push` | Push to a service sends its staged changes, after the Staged page has shown them |

## Rules

- **New changes start unstaged.** Nothing goes out unless Oliver picked it. This replaces holding back from 0005: with nothing pushed by default, there is nothing to hold back.
- **No "never push" decision.** A change Oliver does not want pushed simply stays unstaged.
- **Staging is stored** in `staged_changes` (collection, song, service, add or remove), so it survives restarts and later pulls.
- **A stale pick does not count.** A staged change counts only while the same change still exists: if a pull finds the service already matches main, or main changes so the add became a removal, the pick is ignored and pruned at the end of the next pull.
- **A song in conflict cannot be staged.** The conflict is decided first.
- **Staging an add for a playlist the service does not have** means the push creates that playlist; the Staged page says so.
- **Removals are listed apart from adds** on the Staged page, so they are always seen before anything is written.
- After a push, written changes disappear because the service now matches main; a failed write stays staged with its error so the next push retries it.

## Slices

M5 is built in slices, each stopping for Oliver to check:

1. Staging: per-song toggles, bulk staging per collection and per service, the Staged page, push buttons counting staged changes. No writes. The hero card shows each push as numbered steps (create playlist, add, remove) that stage individually; slice 2 reports push progress on the same steps.
2. Push to Tidal: no scarce quota and 20 ISRCs per lookup, so the safe first writer. Tried on the test playlist first.
3. Push to Spotify: rationed lookups, pausing and resuming on quota.
4. Creating playlists on the other service.
