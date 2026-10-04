<script setup lang="ts">
import type { CleanupOutcome, CleanupView, ConnectionView, DuplicateGroupView, DuplicateTier } from '~~/shared/types'

const { data: connections } = await useFetch<ConnectionView[]>('/api/connections')
const { data: view, refresh } = await useFetch<CleanupView>('/api/cleanup')

const merge = ref<Record<string, boolean>>({})
const keeper = ref<Record<string, string>>({})
const removeEmpty = ref<Record<string, boolean>>({})
const startError = ref<string | null>(null)
const starting = ref(false)

const groups = (tier: DuplicateTier) => (view.value?.groups ?? []).filter(g => g.tier === tier)
const exact = computed(() => groups('exact'))
const empties = computed(() => view.value?.empty ?? [])
const job = computed(() => view.value?.job ?? null)
const running = computed(() => job.value?.running ?? false)

// Exact copies and empty playlists start selected; the confirmation still lists what will be deleted.
watch(view, (v) => {
  for (const g of v?.groups ?? []) {
    if (!g.actionable) continue
    merge.value[g.key] ??= true
    keeper.value[g.key] ??= g.copies[0]!.id
  }
  for (const e of v?.empty ?? []) if (e.actionable) removeEmpty.value[e.key] ??= true
}, { immediate: true })

let poll: ReturnType<typeof setInterval> | null = null
watch(running, (now) => {
  if (now && !poll) poll = setInterval(() => refresh(), 1000)
  if (!now && poll) { clearInterval(poll); poll = null }
}, { immediate: true })
onBeforeUnmount(() => { if (poll) clearInterval(poll) })

const selectedMerges = computed(() => exact.value.filter(g => g.actionable && merge.value[g.key]))
const selectedEmpties = computed(() => empties.value.filter(e => e.actionable && removeEmpty.value[e.key]))
const deletions = computed(() => selectedMerges.value.reduce((n, g) => n + g.copies.length - 1, 0) + selectedEmpties.value.length)
const additions = computed(() => selectedMerges.value.reduce((n, g) => n + kept(g).afterIfKept - kept(g).items, 0))

const kept = (g: DuplicateGroupView) => g.copies.find(c => c.id === keeper.value[g.key]) ?? g.copies[0]!
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`
const providerName = { spotify: 'Spotify', tidal: 'Tidal' } as const

function setAll(on: boolean) {
  for (const g of exact.value) if (g.actionable) merge.value[g.key] = on
  for (const e of empties.value) if (e.actionable) removeEmpty.value[e.key] = on
}

async function start() {
  startError.value = null
  const lines = [
    `Merge ${plural(selectedMerges.value.length, 'group')} of exact copies and remove ${plural(selectedEmpties.value.length, 'empty playlist')} on Tidal?`,
    '',
    `${plural(deletions.value, 'Tidal playlist')} will be deleted, and ${plural(additions.value, 'track')} added to the copies you keep.`,
    'Each group is read again from Tidal first. A copy is deleted only after the kept playlist holds every track of every copy, and is saved in Crossfade before it goes.',
  ]
  if (!confirm(lines.join('\n'))) return
  starting.value = true
  try {
    await $fetch('/api/cleanup', {
      method: 'POST',
      body: { merges: selectedMerges.value.map(g => ({ key: g.key, keeperId: kept(g).id })), empties: selectedEmpties.value.map(e => e.key) },
    })
    await refresh()
  } catch (e: any) {
    startError.value = e?.data?.statusMessage ?? 'Could not start the cleanup'
  } finally {
    starting.value = false
  }
}

const outcomeBadge: Record<CleanupOutcome['status'], { glyph: string, cls: string, label: string }> = {
  queued: { glyph: '·', cls: 'b-outline', label: 'Waiting' },
  running: { glyph: '…', cls: 'b-pending', label: 'Working' },
  done: { glyph: '✓', cls: 'b-mint', label: 'Done' },
  skipped: { glyph: '–', cls: 'b-outline', label: 'Skipped' },
  failed: { glyph: '!', cls: 'b-failed', label: 'Failed' },
  not_attempted: { glyph: '·', cls: 'b-outline', label: 'Not attempted' },
}
const jobCounts = computed(() => {
  const c = { done: 0, skipped: 0, failed: 0, deleted: 0, added: 0, pulled: 0 }
  for (const o of job.value?.outcomes ?? []) {
    if (o.status === 'done') c.done++
    if (o.status === 'skipped') c.skipped++
    if (o.status === 'failed') c.failed++
    c.deleted += o.deleted
    c.added += o.added
    c.pulled += o.pulled
  }
  return c
})

const later = computed(() => [
  { tier: 'contained' as const, title: 'One copy contains the other', note: 'The larger copy already holds at least 90% of every other copy. Not merged yet.', glyph: '⊂', cls: 'b-amber', groups: groups('contained') },
  { tier: 'different' as const, title: 'Same name, different tracks', note: 'These look like separate playlists that share a name. Not merged yet.', glyph: '≠', cls: 'b-outline', groups: groups('different') },
])
</script>

<template>
  <main class="page">
    <AppHeader :connections="connections ?? []" />

    <div class="top">
      <section class="card intro-card">
        <span class="label">Playlist cleanup</span>
        <h1 class="display title">Cleanup</h1>
        <p class="muted intro">
          Duplicate and empty playlists, found in the playlists from your latest Tidal pull
          <template v-if="view?.sources.tidal">(Tidal read {{ formatWhen(view.sources.tidal.fetchedAt) }})</template>.
          Copies are grouped by name and compared by ISRC. Before changing anything, Crossfade reads each group again from Tidal.
          It deletes a copy only after the kept playlist holds every track of every copy, and saves the copy first.
        </p>
        <p v-if="view?.backups" class="mono fine">{{ plural(view.backups, 'deleted playlist') }} saved so far.</p>
      </section>

      <section class="card card-coral action-card" aria-live="polite">
        <div class="action-head">
          <span class="label service-label"><ServiceIcon provider="tidal" :size="14" />Deleted from Tidal</span>
          <span class="display action-count">{{ deletions }}</span>
        </div>
        <p class="action-sub">
          {{ plural(selectedMerges.length, 'merge') }}, {{ plural(selectedEmpties.length, 'empty playlist') }};
          {{ plural(additions, 'track') }} added to the Tidal copies you keep. Spotify is not changed.
        </p>
        <div class="action-buttons">
          <button class="pill outline-dark small" type="button" :disabled="running" @click="setAll(true)">Select all</button>
          <button class="pill outline-dark small" type="button" :disabled="running" @click="setAll(false)">Select none</button>
        </div>
        <button class="pill solid-black" type="button" :disabled="running || starting || !deletions" @click="start">
          {{ running ? 'Cleaning up…' : 'Clean up' }}
        </button>
      </section>
    </div>

    <div v-if="startError" class="banner error" role="alert">{{ startError }}</div>
    <div v-if="!view?.sources.tidal" class="banner pause">Pull Tidal first: cleanup works from the playlists it read.</div>

    <section v-if="job" class="card section" aria-live="polite">
      <div class="section-head">
        <h2 class="section-title">{{ running ? 'Cleaning up' : 'Latest cleanup' }}</h2>
        <span class="mono fine">
          {{ jobCounts.done }} done · {{ jobCounts.skipped }} skipped · {{ jobCounts.failed }} failed · {{ plural(jobCounts.deleted, 'playlist') }} deleted · {{ plural(jobCounts.added, 'track') }} added<template v-if="jobCounts.pulled"> · {{ plural(jobCounts.pulled, 'pulled song') }} remembered</template>
        </span>
      </div>
      <div v-if="job.error" class="banner error">{{ job.error }}</div>
      <div v-if="!running && jobCounts.deleted" class="banner ok">Pull Tidal again to bring main up to date.</div>
      <ul class="list">
        <li v-for="o in job.outcomes" :key="o.key" class="row outcome">
          <span class="badge" :class="outcomeBadge[o.status].cls" role="img" :aria-label="outcomeBadge[o.status].label">{{ outcomeBadge[o.status].glyph }}</span>
          <span class="row-name">{{ o.name }}</span>
          <span class="mono fine service-label"><ServiceIcon provider="tidal" :size="12" />{{ o.kind === 'merge' ? 'merge' : 'empty' }}</span>
          <span class="row-detail" :class="{ failed: o.status === 'failed' }">{{ o.detail ?? outcomeBadge[o.status].label }}</span>
        </li>
      </ul>
    </section>

    <section class="card section">
      <div class="section-head">
        <h2 class="section-title"><span class="badge b-mint" aria-hidden="true">=</span>Exact copies on <ServiceIcon provider="tidal" :size="18" />Tidal</h2>
        <span class="mono fine">{{ plural(exact.length, 'group') }} · at least 90% of the tracks shared</span>
      </div>
      <p class="muted note">Pick the Tidal copy to keep. It gets every track from every copy, then the other Tidal copies are deleted. Spotify playlists are shown for comparison and are not changed.</p>
      <p v-if="!exact.length" class="muted">None.</p>
      <div v-else class="table-head group" aria-hidden="true">
        <span />
        <span class="label">Playlist</span>
        <span class="label service-label"><ServiceIcon provider="spotify" :size="14" />Spotify</span>
        <span class="label service-label"><ServiceIcon provider="tidal" :size="14" />Tidal copies</span>
        <span class="label end">Tidal after</span>
      </div>
      <ul class="list">
        <li v-for="g in exact" :key="g.key" class="row group" :class="{ off: !merge[g.key] }">
          <label class="check">
            <input v-model="merge[g.key]" type="checkbox" :disabled="!g.actionable || running" :aria-label="`Merge the Tidal copies of ${g.name}`">
          </label>
          <div class="row-name">{{ g.name }}</div>
          <div class="cell">
            <span class="cell-service"><ServiceIcon provider="spotify" :size="12" />Spotify</span>
            <template v-if="g.counterpart.length">
              <div v-for="o in g.counterpart" :key="o.id" class="side">
                <span class="mono">{{ plural(o.items, 'track') }}</span>
                <span class="mono fine">not changed</span>
                <a :href="o.url" target="_blank" rel="noopener" class="mono fine open">open ↗</a>
              </div>
            </template>
            <div v-else class="side muted">Not on Spotify</div>
          </div>
          <div class="cell">
            <span class="cell-service"><ServiceIcon provider="tidal" :size="12" />Tidal</span>
            <div class="copies" role="radiogroup" :aria-label="`Tidal copy of ${g.name} to keep`">
              <label v-for="c in g.copies" :key="c.id" class="copy" :class="{ keep: keeper[g.key] === c.id }">
                <input v-model="keeper[g.key]" type="radio" :name="g.key" :value="c.id" :disabled="!g.actionable || running">
                <span class="copy-glyph" aria-hidden="true">{{ keeper[g.key] === c.id ? '●' : '−' }}</span>
                <span class="copy-role mono">{{ keeper[g.key] === c.id ? 'keep on Tidal' : 'delete from Tidal' }}</span>
                <span class="mono">{{ plural(c.items, 'track') }}</span>
                <span v-if="c.unique" class="mono fine">{{ c.unique }} only here</span>
                <a :href="c.url" target="_blank" rel="noopener" class="mono fine open">open ↗</a>
              </label>
            </div>
          </div>
          <div class="after">
            <span class="cell-service"><ServiceIcon provider="tidal" :size="12" />Tidal after</span>
            <span class="mono">{{ plural(kept(g).afterIfKept, 'track') }}</span>
          </div>
        </li>
      </ul>
    </section>

    <section class="card section">
      <div class="section-head">
        <h2 class="section-title"><span class="badge b-coral" aria-hidden="true">−</span>Empty playlists on <ServiceIcon provider="tidal" :size="18" />Tidal</h2>
        <span class="mono fine">{{ plural(empties.length, 'playlist') }}</span>
      </div>
      <p v-if="!empties.length" class="muted">None.</p>
      <div v-else class="table-head empty-row" aria-hidden="true">
        <span />
        <span class="label">Playlist</span>
        <span class="label service-label"><ServiceIcon provider="spotify" :size="14" />Spotify</span>
        <span class="label service-label"><ServiceIcon provider="tidal" :size="14" />Tidal</span>
      </div>
      <ul class="list">
        <li v-for="e in empties" :key="e.key" class="row empty-row" :class="{ off: !removeEmpty[e.key] }">
          <label class="check">
            <input v-model="removeEmpty[e.key]" type="checkbox" :disabled="!e.actionable || running" :aria-label="`Delete ${e.name} from Tidal`">
          </label>
          <span class="row-name">{{ e.name }}</span>
          <div class="cell">
            <span class="cell-service"><ServiceIcon provider="spotify" :size="12" />Spotify</span>
            <div v-for="o in e.counterpart" :key="o.id" class="side">
              <span class="mono">{{ plural(o.items, 'track') }}</span>
              <span class="mono fine">not changed</span>
              <a :href="o.url" target="_blank" rel="noopener" class="mono fine open">open ↗</a>
            </div>
            <div v-if="!e.counterpart.length" class="side muted">Not on Spotify</div>
          </div>
          <div class="cell">
            <span class="cell-service"><ServiceIcon provider="tidal" :size="12" />Tidal</span>
            <div class="side copy">
              <span class="copy-glyph" aria-hidden="true">−</span>
              <span class="copy-role mono">delete from Tidal</span>
              <span class="mono">0 tracks</span>
              <a :href="e.url" target="_blank" rel="noopener" class="mono fine open">open ↗</a>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="view?.pulled.length" class="card section">
      <div class="section-head">
        <h2 class="section-title"><span class="badge b-outline" aria-hidden="true">⊘</span>Pulled from <ServiceIcon provider="tidal" :size="18" />Tidal</h2>
        <span class="mono fine">{{ plural(view.pulled.length, 'song') }} remembered</span>
      </div>
      <p class="muted note">
        Tidal no longer offers these songs, so they could not be copied into the playlist that was kept.
        Crossfade remembers which playlist each belongs in, so it can go back in if Tidal brings it back.
      </p>
      <ul class="list">
        <li v-for="(u, i) in view.pulled" :key="i" class="row pulled-row">
          <div class="min">
            <div class="row-name">{{ u.title ?? 'Unknown song' }}</div>
            <div class="muted small">{{ u.artists.join(', ') || 'Tidal has no details left for it' }}</div>
          </div>
          <span class="mono fine">{{ u.isrc ?? 'no ISRC' }}</span>
          <a :href="u.playlistUrl" target="_blank" rel="noopener" class="mono fine open service-label"><ServiceIcon provider="tidal" :size="12" />{{ u.playlistName }} ↗</a>
        </li>
      </ul>
    </section>

    <section v-for="t in later" :key="t.tier" class="card section later">
      <div class="section-head">
        <h2 class="section-title"><span class="badge" :class="t.cls" aria-hidden="true">{{ t.glyph }}</span>{{ t.title }}</h2>
        <span class="mono fine">{{ plural(t.groups.length, 'group') }} · shown only</span>
      </div>
      <p class="muted note">{{ t.note }}</p>
      <ul class="list">
        <li v-for="g in t.groups" :key="g.key" class="row later-row">
          <span class="row-name">{{ g.name }}</span>
          <span class="mono fine service-label"><ServiceIcon :provider="g.provider" :size="12" />{{ providerName[g.provider] }}</span>
          <span class="mono fine">
            <template v-for="(c, i) in g.copies" :key="c.id"><template v-if="i"> / </template><a :href="c.url" target="_blank" rel="noopener">{{ c.items }}</a></template>
            tracks · {{ g.shared }} shared · {{ g.union }} combined
          </span>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.top { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 16px; margin-bottom: 16px; }
.title { font-size: clamp(28px, 5vw, 44px); margin-top: 10px; }
.intro { max-width: 70ch; margin: 14px 0 0; line-height: 1.5; }
.fine { font-size: 12px; color: var(--text-faint); }
.intro-card .fine { margin: 12px 0 0; }

.action-card { display: flex; flex-direction: column; gap: 14px; }
.action-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.action-count { font-size: 34px; }
.action-sub { margin: 0; font-size: 14px; min-height: 2.6em; }
.action-buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; }

.section { margin-bottom: 16px; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 8px 16px; flex-wrap: wrap; }
.section-title { display: flex; align-items: center; gap: 12px; margin: 0; font-size: 18px; font-weight: 600; }
.note { margin: 10px 0 4px; font-size: 14px; }
.list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 4px; }
.row { display: grid; align-items: center; gap: 8px 14px; padding: 12px 14px; border-radius: var(--radius-row); }
.row:hover { background: var(--raised); }
.row.off { opacity: 0.5; }
.row-name { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.row-detail { font-size: 13px; color: var(--text-muted); }
.row-detail.failed { color: #ffb3ad; }

.service-label { display: inline-flex; align-items: center; gap: 6px; }
.table-head { display: grid; gap: 8px 14px; padding: 14px 14px 4px; align-items: center; }
.table-head .end { text-align: right; }
.group { grid-template-columns: 28px minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 1.6fr) 100px; align-items: start; }
.cell { min-width: 0; }
.cell-service { display: none; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 4px; }
.side { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0; font-size: 13px; }
.check { display: grid; place-items: center; min-height: 24px; }
.check input { width: 18px; height: 18px; accent-color: var(--mint); }
.copies { display: grid; gap: 2px; }
.copy { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0; font-size: 13px; color: var(--text-muted); cursor: pointer; }
.copy input { position: absolute; opacity: 0; pointer-events: none; }
.copy:focus-within { outline: 2px solid var(--mint); outline-offset: 2px; border-radius: 6px; }
.copy.keep { color: var(--text); }
.copy-glyph { width: 14px; text-align: center; color: var(--coral); }
.copy.keep .copy-glyph { color: var(--mint); }
.copy-role { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; min-width: 15ch; }
.copy.keep .copy-role { color: var(--mint); }
.copy:not(.keep) .copy-role, .empty-row .copy-role { color: var(--coral); }
.empty-row .copy { cursor: default; color: var(--text-muted); }
.open { text-decoration: none; }
.open:hover { color: var(--text); }
.after { display: grid; justify-items: end; gap: 4px; padding-top: 4px; font-size: 13px; }

.empty-row { grid-template-columns: 28px minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 1.6fr); align-items: start; }
.later-row { grid-template-columns: minmax(0, 1fr) auto auto; }
.later-row a { color: inherit; }
.pulled-row { grid-template-columns: minmax(0, 1.4fr) auto minmax(0, 1fr); }
.min { min-width: 0; }
.small { font-size: 13px; margin-top: 2px; }
.outcome { grid-template-columns: 30px minmax(0, 1fr) 60px minmax(0, 2fr); }

.badge { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; font-weight: 700; font-size: 14px; flex: none; }
.b-mint { background: var(--mint); color: var(--on-accent); }
.b-coral { background: var(--coral); color: var(--on-accent); }
.b-amber { background: var(--amber); color: var(--on-accent); }
.b-failed { background: #000; color: var(--coral); border: 1.5px solid var(--coral); }
.b-pending { border: 1.5px dashed var(--hairline-strong); color: var(--text-muted); }
.b-outline { border: 1.5px solid var(--hairline-strong); color: var(--text-muted); }

@media (max-width: 760px) {
  .top { grid-template-columns: 1fr; }
  .table-head { display: none; }
  .cell-service { display: flex; }
  .group, .empty-row { grid-template-columns: 28px minmax(0, 1fr); }
  .group > :nth-child(n + 3), .empty-row > :nth-child(n + 3) { grid-column: 2; }
  .after { justify-items: start; }
  .later-row, .pulled-row { grid-template-columns: 1fr; }
  .outcome { grid-template-columns: 30px minmax(0, 1fr); }
  .outcome > :nth-child(n + 3) { grid-column: 2; }
}
</style>
