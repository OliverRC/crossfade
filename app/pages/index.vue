<script setup lang="ts">
import type { CollectionDiff, ConnectionView, DiffRow, RunStatus, SyncResult, TrackView } from '~~/shared/types'

const { data: connections } = await useFetch<ConnectionView[]>('/api/connections')
const { data: library, refresh } = await useFetch<{ result: SyncResult | null, provisional: boolean, run: RunStatus | null, runs: number[] }>('/api/library')
const progress = useSyncProgress(() => refresh())
const run = computed(() => library.value?.run ?? null)
const resumeAt = computed(() => progress.value?.resumeAt ?? run.value?.pause?.resumeAt ?? null)

const selectedKey = ref<string | null>(null)
const showAll = ref(false)
const syncError = ref<string | null>(null)

const allConnected = computed(() => connections.value?.every(c => c.connected && !c.needsReconnect) ?? false)
const collections = computed(() => library.value?.result?.collections ?? [])
const selected = computed<CollectionDiff | undefined>(() => collections.value.find(c => c.key === selectedKey.value) ?? collections.value[0])
const rows = computed(() => (selected.value?.rows ?? []).filter(r => showAll.value || r.state !== 'in_sync'))
const running = computed(() => progress.value?.running ?? false)

const totals = computed(() => {
  const t = { add: 0, review: 0, pending: 0, unmatched: 0, create: 0 }
  for (const c of collections.value) {
    t.add += c.counts.add
    t.review += c.counts.review
    t.unmatched += c.counts.unmatched
    t.pending += c.counts.pending ?? 0
    if (!c.onSpotify || !c.onTidal) t.create++
  }
  return t
})

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const differences = (c: CollectionDiff) => c.counts.add + c.counts.review + (c.counts.pending ?? 0) + c.counts.unmatched

async function sync() {
  syncError.value = null
  try {
    await $fetch('/api/sync', { method: 'POST' })
  } catch (e: any) {
    syncError.value = e?.data?.statusMessage ?? 'Could not start a sync'
  }
}

const name = { spotify: 'Spotify', tidal: 'Tidal' } as const
const fmtDuration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`
const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toISOString().slice(11, 16) + ' UTC' : 'never')
const fmtWhen = formatWhen
const meta = (t: TrackView) => [fmtDuration(t.durationMs), t.isrc].filter(Boolean).join(' · ')

function action(row: DiffRow): { title: string, detail: string, tone: string } {
  const to = row.target ? name[row.target].toUpperCase() : ''
  switch (row.state) {
    case 'add': return { title: `Add → ${to}`, detail: `${row.method === 'isrc' ? 'isrc' : row.method} match ${(row.confidence ?? 1).toFixed(2)}`, tone: '' }
    case 'review': return { title: 'Review match', detail: `candidate · score ${(row.candidate?.score ?? 0).toFixed(2)}`, tone: 'amber' }
    case 'pending': return { title: 'Not checked yet', detail: `lookup on ${row.target} waits for the next run`, tone: 'muted' }
    case 'unmatched': return { title: 'Unmatched', detail: unmatchedDetail(row), tone: 'muted' }
    default: return { title: 'In sync', detail: '', tone: 'muted' }
  }
}

function unmatchedDetail(row: DiffRow): string {
  switch (row.reason) {
    case 'no_isrc_match': return row.spotify?.isrc || row.tidal?.isrc ? `no isrc match on ${row.target}` : 'no isrc to look up'
    case 'low_confidence': return 'candidates found, none good enough'
    case 'ignored': return 'ignored by you'
    default: return `isrc and search empty on ${row.target}`
  }
}

const gap = (row: DiffRow) => (row.state === 'unmatched' ? `Not found on ${row.target}` : 'Not in library')
</script>

<template>
  <main class="page">
    <AppHeader :connections="connections ?? []" />

    <div v-if="!allConnected" class="banner error">
      Connect both services before the first sync. <NuxtLink to="/connections">Go to Connections</NuxtLink>
    </div>
    <div v-if="syncError" class="banner error" role="alert">{{ syncError }}</div>
    <div v-else-if="!running && run?.status === 'failed'" class="banner error" role="alert">
      The last sync stopped during {{ run.phase ?? 'start-up' }}: {{ progress?.error || run.error }}. Everything it fetched and matched is saved; Sync resumes from there.
    </div>
    <div v-else-if="!running && run?.status === 'paused' && run.pause" class="banner pause">
      <strong>Paused:</strong> {{ run.pause.message }}.
      <template v-if="run.pause.reason === 'quota'">Spotify doesn't publish its quota, and resets have taken 13 to 18 hours.</template>
      Progress is saved<template v-if="run.pending"> and {{ plural(run.pending, 'track') }} {{ run.pending === 1 ? 'is' : 'are' }} still to look up</template>.
      Crossfade continues automatically <template v-if="resumeAt">at {{ fmtWhen(resumeAt) }}</template>; nothing is written.
      <NuxtLink :to="`/runs/${run.id}`">See where it stopped</NuxtLink>
    </div>

    <section class="top">
      <div class="card card-mint hero">
        <div class="hero-head">
          <div>
            <div class="label">Collection</div>
            <h1 class="display hero-title">{{ selected?.name ?? 'No sync yet' }}</h1>
          </div>
          <div class="mono hero-meta">
            <div>{{ plural(selected?.counts.total ?? 0, 'track') }}</div>
            <div>{{ library?.provisional ? 'unfinished run' : 'last run' }} {{ fmtTime(library?.result?.finishedAt) }}</div>
          </div>
        </div>
        <p v-if="selected && (!selected.onSpotify || !selected.onTidal)" class="hero-note">
          Only on {{ selected.onSpotify ? 'Spotify' : 'Tidal' }}: Apply would create it on {{ selected.onSpotify ? 'Tidal' : 'Spotify' }} first.
        </p>
        <div class="hero-foot">
          <div class="pills">
            <span class="pill small outline-dark">{{ selected?.counts.in_sync ?? 0 }} in sync</span>
            <span class="pill small outline-dark">{{ selected ? differences(selected) : 0 }} {{ selected && differences(selected) === 1 ? 'difference' : 'differences' }}</span>
            <span v-if="selected?.counts.review" class="pill small solid-black">{{ selected.counts.review }} to review</span>
          </div>
          <div class="pills">
            <span class="pill small solid-black">Merge</span>
            <span class="pill small outline-dark" aria-disabled="true" title="Mirror arrives with the queue (M4)">Mirror S → T</span>
            <span class="pill small outline-dark" aria-disabled="true" title="Mirror arrives with the queue (M4)">Mirror T → S</span>
          </div>
        </div>
      </div>

      <div class="card card-coral queue">
        <div class="queue-head">
          <h2 class="display queue-count">{{ totals.add }} planned</h2>
          <span class="pill small solid-black">Nothing written yet</span>
        </div>
        <div class="label queue-sub">
          <template v-if="running">{{ progress?.message }}<span v-if="progress?.total"> · {{ progress.done }}/{{ progress.total }}</span></template>
          <template v-else>{{ plural(totals.add, 'add') }} · {{ plural(totals.review, 'review') }}<span v-if="totals.pending"> · {{ totals.pending }} not checked</span> · {{ totals.unmatched }} unmatched<span v-if="totals.create"> · {{ plural(totals.create, 'playlist') }} to create</span></template>
        </div>
        <EqualizerDots class="queue-eq" :values="library?.runs ?? []" :columns="20" :animate="running" />
        <NuxtLink v-if="run" :to="`/runs/${run.id}`" class="mono view-run">{{ running || run.status !== 'succeeded' ? 'Watch this sync' : 'See how the last sync went' }} →</NuxtLink>
        <div class="queue-actions">
          <button class="pill outline-dark" type="button" :disabled="running || !allConnected" @click="sync">{{ running ? 'Syncing' : run && run.status !== 'succeeded' ? 'Resume' : 'Sync' }}</button>
          <button class="pill solid-black" type="button" disabled title="Apply arrives in M5. V0 only plans.">Apply {{ totals.add }}</button>
        </div>
      </div>
    </section>

    <section class="body">
      <aside class="side">
        <div class="label side-label">Collections</div>
        <nav class="collections" aria-label="Collections">
          <button
            v-for="c in collections" :key="c.key" type="button" class="collection"
            :class="{ active: c.key === selected?.key }" @click="selectedKey = c.key"
          >
            <span class="collection-name">{{ c.name }}</span>
            <span v-if="!c.onSpotify || !c.onTidal" class="label">{{ c.onSpotify ? 'S only' : 'T only' }}</span>
            <span v-else-if="differences(c)" class="mono count" :class="{ amber: c.counts.review }">{{ differences(c) }}</span>
            <span v-else class="label">Synced</span>
          </button>
          <p v-if="!collections.length" class="muted empty">Run a sync to see your collections.</p>
        </nav>
        <div class="card runs">
          <div class="runs-head"><span class="label">Last 20 runs</span><span class="label">Changes</span></div>
          <EqualizerDots class="runs-eq" :values="library?.runs ?? []" :columns="20" />
        </div>
      </aside>

      <div class="card table">
        <div class="table-head">
          <span class="label col-label"><ServiceIcon provider="spotify" :size="14" /> Spotify</span>
          <span />
          <span class="label col-label"><ServiceIcon provider="tidal" :size="14" /> Tidal</span>
          <span class="label">Action</span>
          <div class="toggle">
            <button type="button" class="pill small" :class="{ 'solid-mint': !showAll }" @click="showAll = false">Differences</button>
            <button type="button" class="pill small" :class="{ 'solid-mint': showAll }" @click="showAll = true">All</button>
          </div>
        </div>

        <p v-if="!library?.result" class="muted empty">No sync yet. Connect both services, then press Sync. It only reads; nothing is written.</p>
        <p v-else-if="!rows.length" class="muted empty">No differences in this collection.</p>

        <div v-for="row in rows" :key="row.canonicalTrackId" class="row" :class="row.state">
          <div class="cell">
            <template v-if="row.spotify">
              <div class="track-title">{{ row.spotify.title }}</div>
              <div class="track-artist">{{ row.spotify.artists.join(', ') }}</div>
              <div class="mono track-meta">{{ meta(row.spotify) }}</div>
            </template>
            <span v-else class="pill small dashed">{{ gap(row) }}</span>
          </div>
          <StateBadge :state="row.state" />
          <div class="cell">
            <template v-if="row.tidal">
              <div class="track-title">{{ row.tidal.title }}</div>
              <div class="track-artist">{{ row.tidal.artists.join(', ') }}</div>
              <div class="mono track-meta">{{ meta(row.tidal) }}</div>
            </template>
            <template v-else-if="row.candidate && row.target === 'tidal'">
              <div class="track-title">{{ row.candidate.title }}</div>
              <div class="track-artist">{{ row.candidate.artists.join(', ') }}</div>
              <div class="mono track-meta">candidate · score {{ row.candidate.score.toFixed(2) }}</div>
            </template>
            <span v-else class="pill small dashed">{{ gap(row) }}</span>
          </div>
          <div class="cell">
            <div class="mono action-title" :class="action(row).tone">{{ action(row).title }}</div>
            <div class="mono track-meta">{{ action(row).detail }}</div>
          </div>
          <div class="cell end">
            <span v-if="row.state === 'add'" class="pill small solid-mint">Planned</span>
            <span v-else-if="row.state === 'review'" class="pill small outline-amber" aria-disabled="true" title="Manual search arrives in M3">Find match</span>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.top { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 16px; }
.hero { display: flex; flex-direction: column; justify-content: space-between; gap: 32px; min-height: 240px; }
.hero-head { display: flex; justify-content: space-between; gap: 16px; }
.hero-title { font-size: clamp(30px, 5vw, 52px); margin-top: 8px; overflow-wrap: anywhere; }
.hero-meta { text-align: right; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; line-height: 1.7; }
.hero-note { margin: 0; font-size: 14px; }
.hero-foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; }

.queue { display: flex; flex-direction: column; gap: 14px; }
.queue-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.queue-count { font-size: 28px; white-space: nowrap; }
.queue-sub { min-height: 2.4em; }
.queue-eq { color: #000; }
.view-run { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #000; padding: 6px 0; }
.queue-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: auto; }

.body { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 16px; margin-top: 16px; align-items: start; }
.side-label { margin: 8px 8px 12px; }
.collections { display: grid; gap: 8px; }
.collection {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-height: 44px; padding: 0 18px; border-radius: 999px; border: 1.5px solid var(--hairline); background: transparent; cursor: pointer; text-align: left;
}
.collection.active { background: var(--raised); border-color: var(--text-muted); }
.collection-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: 12px; }
.amber { color: var(--amber); }
.runs { margin-top: 16px; padding: 18px; color: var(--mint); }
.runs-head { display: flex; justify-content: space-between; margin-bottom: 12px; }
.runs-head .label:last-child { color: var(--text); }
.empty { padding: 8px; }

.table { padding: 12px; overflow: hidden; }
.table-head, .row { display: grid; grid-template-columns: minmax(0, 1.3fr) 36px minmax(0, 1.3fr) minmax(0, 1.2fr) 120px; gap: 14px; align-items: center; }
.table-head { padding: 12px 14px; }
.col-label { display: inline-flex; align-items: center; gap: 8px; }
.toggle { display: flex; gap: 4px; justify-content: flex-end; }
.row { padding: 14px; border-radius: var(--radius-row); }
.row.review { background: rgba(242, 184, 75, 0.08); }
.cell { min-width: 0; }
.cell.end { display: flex; justify-content: flex-end; }
.track-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track-artist { color: var(--text-muted); font-size: 13px; margin-top: 2px; }
.track-meta { color: var(--text-faint); font-size: 11px; margin-top: 3px; }
.action-title { font-size: 12px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; }
.action-title.amber { color: var(--amber); }
.action-title.muted { color: var(--text-muted); }

@media (max-width: 1000px) {
  .top, .body { grid-template-columns: 1fr; }
  .table-head { display: none; }
  .row { grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr); }
  .row > .cell:nth-child(4) { grid-column: 1 / 3; }
}
</style>
