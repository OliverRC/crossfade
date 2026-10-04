<script setup lang="ts">
import type { CollectionStatusView, ConnectionView, HoldView, LibraryView, ProviderId, SideState, StatusRowView } from '~~/shared/types'

const selectedKey = ref<string | undefined>(undefined)
const { data: connections } = await useFetch<ConnectionView[]>('/api/connections')
const { data: library, refresh } = await useFetch<LibraryView>('/api/library', { query: { collection: selectedKey } })
const progress = useRunProgress(() => refresh())

const showAll = ref(false)
const filter = ref('')
const actionError = ref<string | null>(null)

const names = { spotify: 'Spotify', tidal: 'Tidal' } as const
const PROVIDERS = ['spotify', 'tidal'] as const
const connected = (p: ProviderId) => connections.value?.some(c => c.provider === p && c.connected && !c.needsReconnect) ?? false
const collections = computed(() => library.value?.collections ?? [])
const selected = computed<CollectionStatusView | undefined>(() => collections.value.find(c => c.key === library.value?.selected?.key))
// Differences leaves out songs in sync and songs a service has not been pulled for yet; All shows everything.
const rows = computed(() => (library.value?.selected?.rows ?? []).filter(r => showAll.value || (r.state !== 'in_sync' && r.state !== 'unknown')))
const hiddenUnknown = computed(() => showAll.value ? 0 : (library.value?.selected?.rows ?? []).filter(r => r.state === 'unknown').length)
const running = computed(() => progress.value?.running ?? false)
const pulling = (p: ProviderId) => running.value && progress.value?.provider === p
const anyPulled = computed(() => PROVIDERS.some(p => library.value?.services[p].pulledAt))
/** A service with no pull yet: until it has one, "only on one service" and "synced" mean nothing. */
const unpulled = computed(() => PROVIDERS.filter(p => !library.value?.services[p].pulledAt))

const waiting = (c: { add: Record<ProviderId, number>, remove: Record<ProviderId, number> }) =>
  ({ spotify: c.add.spotify + c.remove.spotify, tidal: c.add.tidal + c.remove.tidal })
const differences = (c: CollectionStatusView) => c.counts.conflicts + waiting(c.counts).spotify + waiting(c.counts).tidal
const needsAttention = (c: CollectionStatusView) => c.holds.length > 0 || differences(c) > 0 || (!unpulled.value.length && (!c.on.spotify || !c.on.tidal))
/** Liked songs first, then collections that need attention, then the ones in sync; each group by name. */
const groups = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const shown = collections.value.filter(c => !q || c.name.toLowerCase().includes(q))
  return [
    { label: null, items: shown.filter(c => c.kind === 'liked') },
    { label: 'Needs attention', items: shown.filter(c => c.kind !== 'liked' && needsAttention(c)) },
    { label: 'In sync', items: shown.filter(c => c.kind !== 'liked' && !needsAttention(c)) },
  ].filter(g => g.items.length)
})
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`
const fmtDuration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`

async function act(request: () => Promise<unknown>) {
  actionError.value = null
  try {
    await request()
    await refresh()
  } catch (e: any) {
    actionError.value = e?.data?.statusMessage ?? 'That did not work'
  }
}
const post = (url: string, body?: Record<string, string>) => act(() => $fetch<unknown>(url, { method: 'POST', body }))
const pull = (p: ProviderId) => post(`/api/pull/${p}`)
const decideConflict = (row: StatusRowView, resolution: 'keep' | 'remove') => post(`/api/conflicts/${row.conflict!.id}`, { resolution })
const decideHold = (h: HoldView, action: 'accept' | 'keep' | 'remove') => post(`/api/holds/${h.id}`, { action })

function holdText(h: HoldView): string {
  const service = names[h.provider]
  if (h.reason === 'empty') return `came back empty from ${service} after ${plural(h.before, 'song')}`
  if (h.reason === 'gone') return `is no longer on ${service}`
  return `would lose ${h.removing} of its ${plural(h.before, 'song')} on ${service}`
}

/** What one service holds for a row, when it holds nothing worth showing a track for. */
const gapLabel: Partial<Record<SideState, string>> = { missing: 'Not here yet', absent: 'Removed', unknown: 'Not pulled yet' }
const showsTrack = (s: SideState) => s === 'present' || s === 'unavailable' || s === 'extra'

function action(row: StatusRowView): { title: string, detail: string, tone: string } {
  if (row.conflict) {
    const by = names[row.conflict.provider]
    return row.conflict.change === 'removed'
      ? { title: 'Conflict', detail: `removed on ${by}, but added elsewhere since`, tone: 'amber' }
      : { title: 'Conflict', detail: `added on ${by}, but removed from main since`, tone: 'amber' }
  }
  const to = (state: SideState) => PROVIDERS.filter(p => row[p] === state).map(p => names[p]).join(' and ')
  switch (row.state) {
    case 'add': return { title: `Push → ${to('missing')}`, detail: 'in main, not there yet', tone: '' }
    case 'remove': return { title: `Remove on ${to('extra')}`, detail: 'removed from main', tone: 'coral' }
    case 'unavailable': return { title: `Unavailable on ${to('unavailable')}`, detail: 'listed, but not playable in your country; kept in main', tone: 'muted' }
    case 'unknown': return { title: `Pull ${to('unknown')} to compare`, detail: '', tone: 'muted' }
    default: return { title: 'In sync', detail: '', tone: 'muted' }
  }
}
</script>

<template>
  <main class="page">
    <AppHeader :connections="connections ?? []" />

    <div v-if="actionError" class="banner error" role="alert">{{ actionError }}</div>
    <template v-for="p in PROVIDERS" :key="p">
      <div v-if="!running && library?.services[p].run?.status === 'failed'" class="banner error" role="alert">
        The last {{ names[p] }} pull stopped: {{ library.services[p].run!.error }}. Everything it fetched is saved; pull again to resume.
        <NuxtLink :to="`/activity/${library.services[p].run!.id}`">See where it stopped</NuxtLink>
      </div>
      <div v-else-if="!running && library?.services[p].run?.status === 'paused' && library.services[p].run!.pause" class="banner pause">
        <strong>{{ names[p] }} pull paused:</strong> {{ library.services[p].run!.pause!.message }}.
        Progress is saved and it continues automatically at {{ formatWhen(library.services[p].run!.pause!.resumeAt) }}.
        <NuxtLink :to="`/activity/${library.services[p].run!.id}`">See where it stopped</NuxtLink>
      </div>
    </template>

    <section class="top">
      <div class="card card-mint hero">
        <div class="hero-head">
          <div>
            <div class="label">{{ selected?.kind === 'liked' ? 'Liked songs' : 'Playlist' }}</div>
            <h1 class="display hero-title">{{ selected?.name ?? 'Nothing pulled yet' }}</h1>
          </div>
          <div class="mono hero-meta">
            <div v-for="p in PROVIDERS" :key="p" class="hero-service">
              <ServiceIcon :provider="p" :size="12" :dim="!selected?.on[p]" />
              {{ selected?.on[p] ? `on ${names[p]}` : `not on ${names[p]}` }}
            </div>
          </div>
        </div>
        <div v-for="h in selected?.holds ?? []" :key="h.id" class="hold" role="status">
          <span class="badge-mini" aria-hidden="true">‖</span>
          <span>Held: this {{ selected?.kind === 'liked' ? 'collection' : 'playlist' }} {{ holdText(h) }}. Nothing in it was merged.</span>
          <span class="hold-actions">
            <template v-if="h.reason === 'gone'">
              <button type="button" class="pill small solid-black" @click="decideHold(h, 'keep')">Keep in main</button>
              <button type="button" class="pill small outline-dark" @click="decideHold(h, 'remove')">Remove from main</button>
            </template>
            <button v-else type="button" class="pill small solid-black" @click="decideHold(h, 'accept')">Accept the removals</button>
          </span>
        </div>
        <div class="hero-foot">
          <div class="pills">
            <span class="pill small outline-dark">{{ plural(selected?.counts.inSync ?? 0, 'song') }} in sync</span>
            <span v-if="selected?.counts.conflicts" class="pill small solid-black">? {{ plural(selected.counts.conflicts, 'conflict') }}</span>
            <span v-for="p in PROVIDERS" v-show="selected?.counts.unavailable[p]" :key="p" class="pill small outline-dark">⊘ {{ selected?.counts.unavailable[p] }} unavailable on {{ names[p] }}</span>
          </div>
          <PushButton v-if="selected" :waiting="waiting(selected.counts)" small dark />
        </div>
      </div>

      <div class="card card-coral main-card">
        <div class="main-head">
          <h2 class="display main-title">Main</h2>
          <span class="label">{{ library?.totals.held ? `${plural(library.totals.held, 'collection')} held` : 'Pull reads; push writes' }}</span>
        </div>
        <div v-for="p in PROVIDERS" :key="p" class="service">
          <ServiceIcon :provider="p" :size="18" />
          <div class="service-text">
            <div class="service-name">{{ names[p] }}</div>
            <div class="mono service-meta">
              <template v-if="pulling(p)">{{ progress?.message }}<span v-if="progress?.total"> · {{ progress.done }}/{{ progress.total }}</span></template>
              <template v-else-if="library?.services[p].pulledAt">pulled {{ formatWhen(library.services[p].pulledAt!) }} · {{ plural(waiting(library.totals)[p], 'change') }} to push</template>
              <template v-else>never pulled</template>
            </div>
          </div>
          <button type="button" class="pill small solid-black" :disabled="running || !connected(p)" :title="connected(p) ? '' : `Connect ${names[p]} first`" @click="pull(p)">
            {{ pulling(p) ? 'Pulling' : library?.services[p].run && library.services[p].run!.status !== 'succeeded' ? `Resume ${names[p]}` : `Pull ${names[p]}` }}
          </button>
        </div>
        <EqualizerDots class="main-eq" :values="library?.recent ?? []" :columns="20" :animate="running" />
        <div class="main-foot">
          <span class="label">{{ library?.totals.conflicts ? plural(library.totals.conflicts, 'conflict') : 'Whole library' }}</span>
          <PushButton v-if="library" :waiting="waiting(library.totals)" dark />
        </div>
      </div>
    </section>

    <section class="body">
      <aside class="side card">
        <div class="side-head">
          <span class="label">Collections</span>
          <span class="mono count">{{ collections.length }}</span>
        </div>
        <input v-if="collections.length > 8" v-model="filter" type="search" class="filter" placeholder="Filter playlists" aria-label="Filter collections">
        <nav class="collections" aria-label="Collections">
          <template v-for="g in groups" :key="g.label ?? 'liked'">
            <div v-if="g.label" class="label group-label">{{ g.label === 'In sync' && unpulled.length ? 'Not compared yet' : g.label }} · {{ g.items.length }}</div>
            <button
              v-for="c in g.items" :key="c.key" type="button" class="collection"
              :class="{ active: c.key === selected?.key }" :title="c.name" @click="selectedKey = c.key"
            >
              <span class="collection-name">{{ c.name }}</span>
              <span v-if="c.holds.length" class="label amber">held</span>
              <span v-else-if="c.counts.conflicts" class="mono count amber">? {{ c.counts.conflicts }}</span>
              <span v-else-if="differences(c)" class="mono count">{{ differences(c) }}</span>
              <span v-else-if="unpulled.length" class="label" :title="`Pull ${unpulled.map(p => names[p]).join(' and ')} to compare`">…</span>
              <span v-else-if="!c.on.spotify || !c.on.tidal" class="label">{{ c.on.spotify ? 'S only' : 'T only' }}</span>
              <span v-else class="label">Synced</span>
            </button>
          </template>
          <p v-if="!collections.length" class="muted empty">Pull a service to fill main.</p>
          <p v-else-if="!groups.length" class="muted empty">No collection matches.</p>
        </nav>
      </aside>

      <div class="card table">
        <div class="table-head">
          <span class="label col-label"><ServiceIcon provider="spotify" :size="14" /> Spotify</span>
          <span />
          <span class="label col-label"><ServiceIcon provider="tidal" :size="14" /> Tidal</span>
          <span class="label">Next</span>
          <div class="toggle">
            <button type="button" class="pill small" :class="{ 'solid-mint': !showAll }" @click="showAll = false">Differences</button>
            <button type="button" class="pill small" :class="{ 'solid-mint': showAll }" @click="showAll = true">All</button>
          </div>
        </div>

        <p v-if="!anyPulled" class="muted empty">Main is empty. Pull Spotify and pull Tidal: each reads one service into main, and nothing is written to either.</p>
        <p v-if="hiddenUnknown" class="muted empty">
          {{ plural(hiddenUnknown, 'song') }} not compared yet: pull {{ unpulled.map(p => names[p]).join(' and ') }} to see {{ hiddenUnknown === 1 ? 'it' : 'them' }} side by side, or show All.
        </p>
        <p v-else-if="anyPulled && !rows.length" class="muted empty">No differences in this collection.</p>

        <div v-for="row in rows" :key="row.canonicalTrackId" class="row" :class="row.state">
          <div v-for="p in PROVIDERS" :key="p" class="cell" :style="{ order: p === 'spotify' ? 1 : 3 }">
            <template v-if="showsTrack(row[p])">
              <div class="track-title" :class="{ struck: row[p] === 'extra' }">{{ row.track.title }}</div>
              <div class="track-artist">{{ row.track.artists.join(', ') }}</div>
              <div class="mono track-meta">
                {{ [fmtDuration(row.track.durationMs), row.track.isrc].filter(Boolean).join(' · ') }}
                <span v-if="row[p] === 'unavailable'" class="tag">⊘ unavailable here</span>
                <span v-if="row[p] === 'extra'" class="tag coral">− removed in main</span>
              </div>
            </template>
            <span v-else class="pill small dashed">{{ gapLabel[row[p]] }}</span>
          </div>
          <StateBadge :state="row.state" :style="{ order: 2 }" />
          <div class="cell" :style="{ order: 4 }">
            <div class="mono action-title" :class="action(row).tone">{{ action(row).title }}</div>
            <div class="mono track-meta">{{ action(row).detail }}</div>
          </div>
          <div class="cell end" :style="{ order: 5 }">
            <template v-if="row.conflict">
              <button type="button" class="pill small outline-amber" @click="decideConflict(row, 'keep')">Keep</button>
              <button type="button" class="pill small" @click="decideConflict(row, 'remove')">Remove</button>
            </template>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.top { display: grid; grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr); gap: 16px; }
.hero { display: flex; flex-direction: column; justify-content: space-between; gap: 24px; min-height: 200px; }
.hero-head { display: flex; justify-content: space-between; gap: 16px; }
.hero-title { font-size: clamp(30px, 5vw, 52px); margin-top: 8px; overflow-wrap: anywhere; }
.hero-meta { text-align: right; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; line-height: 1.9; }
.hero-service { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.hero-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; }
.hold { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px; border-radius: var(--radius-row); background: rgba(0, 0, 0, 0.08); font-size: 14px; }
.hold-actions { display: flex; gap: 6px; margin-left: auto; }
.badge-mini { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: #000; color: var(--amber); font-weight: 700; font-size: 12px; flex: none; }

.main-card { display: flex; flex-direction: column; gap: 12px; }
.main-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.main-title { font-size: 28px; }
.service { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid rgba(0, 0, 0, 0.18); }
.service :deep(.icon) { color: #000; }
.service-name { font-weight: 600; }
.service-meta { font-size: 11px; color: rgba(0, 0, 0, 0.7); overflow-wrap: anywhere; }
.main-eq { color: #000; }
.main-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: auto; }

.body { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 16px; margin-top: 16px; align-items: start; }
/* The list stays in view and scrolls on its own, however many playlists there are. */
.side {
  position: sticky; top: 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0;
  max-height: calc(100vh - 32px); padding: 16px 12px 12px;
}
.side-head { display: flex; justify-content: space-between; align-items: baseline; padding: 0 6px; }
.filter {
  width: 100%; min-height: 38px; padding: 0 14px; border-radius: 999px; border: 1.5px solid var(--hairline-strong);
  background: var(--ground); color: var(--text); font: inherit; font-size: 13px;
}
.collections { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; min-height: 0; margin: 0 -4px; padding: 0 4px 4px; }
.group-label { padding: 12px 8px 4px; }
.collection {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; width: 100%; min-width: 0;
  min-height: 38px; padding: 0 14px; border-radius: 999px; border: 1.5px solid transparent; background: transparent; cursor: pointer; text-align: left; font-size: 14px;
}
.collection:hover { background: var(--raised); }
.collection.active { background: var(--raised); border-color: var(--text-muted); }
.collection-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.collection > :not(.collection-name) { flex: none; }
.count { font-size: 12px; }
.amber { color: var(--amber); }
.empty { padding: 8px; }

.table { padding: 12px; overflow: hidden; }
.table-head, .row { display: grid; grid-template-columns: minmax(0, 1.3fr) 36px minmax(0, 1.3fr) minmax(0, 1.2fr) 150px; gap: 14px; align-items: center; }
.table-head { padding: 12px 14px; }
.col-label { display: inline-flex; align-items: center; gap: 8px; }
.toggle { display: flex; gap: 4px; justify-content: flex-end; }
.row { padding: 14px; border-radius: var(--radius-row); }
.row.conflict { background: rgba(242, 184, 75, 0.08); }
.cell { min-width: 0; }
.cell.end { display: flex; justify-content: flex-end; gap: 6px; }
.track-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track-title.struck { text-decoration: line-through; text-decoration-color: var(--coral); }
.track-artist { color: var(--text-muted); font-size: 13px; margin-top: 2px; }
.track-meta { color: var(--text-faint); font-size: 11px; margin-top: 3px; }
.tag { display: block; margin-top: 2px; color: var(--text-muted); }
.tag.coral { color: var(--coral); }
.action-title { font-size: 12px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; }
.action-title.amber { color: var(--amber); }
.action-title.coral { color: var(--coral); }
.action-title.muted { color: var(--text-muted); }

@media (max-width: 1000px) {
  .top, .body { grid-template-columns: 1fr; }
  .side { position: static; max-height: 360px; }
  .table-head { display: none; }
  .row { grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr); }
  .row > .cell:nth-last-child(-n + 2) { grid-column: 1 / -1; }
  .cell.end { justify-content: flex-start; }
}
</style>
