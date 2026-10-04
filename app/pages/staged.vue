<script setup lang="ts">
// Staged (docs/decisions/0007): what the next push to each service will do. Removals are listed apart from adds so
// they are always seen before anything is written. Push itself arrives in the next step of M5.
import type { ConnectionView, ProviderId, StagedCollectionView, StagedView } from '~~/shared/types'

const { data: connections } = await useFetch<ConnectionView[]>('/api/connections')
const { data: view, refresh } = await useFetch<StagedView>('/api/staged')
const actionError = ref<string | null>(null)

const names = { spotify: 'Spotify', tidal: 'Tidal' } as const
const PROVIDERS = ['spotify', 'tidal'] as const
const NOT_YET = 'Writing arrives in the next step of M5. Staging is saved until then.'
const total = computed(() => PROVIDERS.reduce((n, p) => n + (view.value?.[p].add ?? 0) + (view.value?.[p].remove ?? 0), 0))
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`
const fmtDuration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`
const withRemovals = (p: ProviderId) => (view.value?.[p].collections ?? []).filter(c => c.remove.length)
const withAdds = (p: ProviderId) => (view.value?.[p].collections ?? []).filter(c => c.add.length)

async function unstage(filter: { collection?: string, track?: number, provider: ProviderId }) {
  actionError.value = null
  try {
    await $fetch('/api/staged', { method: 'POST', body: { ...filter, staged: false } })
    await refresh()
  } catch (e: any) {
    actionError.value = e?.data?.statusMessage ?? 'That did not work'
  }
}
const where = (c: StagedCollectionView) => [
  c.createsPlaylist ? 'new playlist' : null,
  c.ownerName ? `${c.ownerName}'s, collaborative` : null,
].filter(Boolean).join(' · ')
</script>

<template>
  <main class="page">
    <AppHeader :connections="connections ?? []" />
    <div v-if="actionError" class="banner error" role="alert">{{ actionError }}</div>

    <section class="card intro-card">
      <h1 class="display title">Staged</h1>
      <p class="intro muted">
        What the next push to each service will do. Stage changes on the Library page, song by song or a playlist at a time; new changes start unstaged,
        so nothing goes out unless you picked it. A staged change that a later pull finds already done leaves the stage by itself.
      </p>
    </section>

    <p v-if="!total" class="card muted empty">Nothing is staged. <NuxtLink to="/">Pick changes on the Library page.</NuxtLink></p>

    <template v-for="p in PROVIDERS" :key="p">
      <section v-if="view && (view[p].add || view[p].remove)" :id="p" class="card section">
        <div class="section-head">
          <h2 class="section-title"><ServiceIcon :provider="p" :size="20" /> Push to {{ names[p] }}</h2>
          <div class="head-actions">
            <span class="mono counts">
              <span class="mint">+ {{ view[p].add.toLocaleString('en-GB') }}</span>
              <span class="coral">− {{ view[p].remove.toLocaleString('en-GB') }}</span>
            </span>
            <button type="button" class="pill small" @click="unstage({ provider: p })">Unstage all</button>
            <button type="button" class="pill small solid-coral" disabled :title="NOT_YET">Push to {{ names[p] }}</button>
          </div>
        </div>

        <div v-if="view[p].remove" class="block removals">
          <h3 class="block-title"><span class="badge b-coral" aria-hidden="true">−</span>Remove from {{ names[p] }} · {{ plural(view[p].remove, 'song') }}</h3>
          <div v-for="c in withRemovals(p)" :key="`r-${c.key}`" class="group">
            <div class="group-head">
              <span class="group-name">{{ c.name }}</span>
              <span v-if="where(c)" class="label">{{ where(c) }}</span>
            </div>
            <div v-for="t in c.remove" :key="t.canonicalTrackId" class="song">
              <div class="song-text">
                <span class="song-title">{{ t.title }}</span>
                <span class="muted">{{ t.artists.join(', ') }}</span>
              </div>
              <span class="mono meta">{{ [fmtDuration(t.durationMs), t.isrc].filter(Boolean).join(' · ') }}</span>
              <button type="button" class="pill small" @click="unstage({ collection: c.key, track: t.canonicalTrackId, provider: p })">Unstage</button>
            </div>
          </div>
        </div>

        <div v-if="view[p].add" class="block">
          <h3 class="block-title"><span class="badge b-mint" aria-hidden="true">+</span>Add to {{ names[p] }} · {{ plural(view[p].add, 'song') }}</h3>
          <details v-for="c in withAdds(p)" :key="`a-${c.key}`" class="group" :open="withAdds(p).length <= 3">
            <summary class="group-head">
              <span class="group-name">{{ c.name }}</span>
              <span class="mono meta">{{ plural(c.add.length, 'song') }}</span>
              <span v-if="where(c)" class="label" :class="{ mint: c.createsPlaylist }">{{ where(c) }}</span>
              <button type="button" class="pill small group-unstage" @click.prevent="unstage({ collection: c.key, provider: p })">Unstage playlist</button>
            </summary>
            <div v-for="t in c.add" :key="t.canonicalTrackId" class="song">
              <div class="song-text">
                <span class="song-title">{{ t.title }}</span>
                <span class="muted">{{ t.artists.join(', ') }}</span>
              </div>
              <span class="mono meta">{{ [fmtDuration(t.durationMs), t.isrc].filter(Boolean).join(' · ') }}</span>
              <button type="button" class="pill small" @click="unstage({ collection: c.key, track: t.canonicalTrackId, provider: p })">Unstage</button>
            </div>
          </details>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.intro-card { margin-bottom: 16px; }
.title { font-size: clamp(28px, 4vw, 44px); }
.intro { max-width: 70ch; margin: 14px 0 0; line-height: 1.5; }
.empty { margin-bottom: 16px; }
.section { margin-bottom: 16px; scroll-margin-top: 16px; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 8px 16px; flex-wrap: wrap; }
.section-title { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 20px; font-weight: 600; }
.head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.counts { display: inline-flex; gap: 10px; font-size: 13px; margin-right: 4px; }
.mint { color: var(--mint); }
.coral { color: var(--coral); }
.block { margin-top: 20px; }
.removals { padding: 16px; border-radius: var(--radius-row); background: rgba(255, 68, 56, 0.08); border: 1px solid rgba(255, 68, 56, 0.35); }
.block-title { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.badge { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; font-weight: 700; font-size: 13px; flex: none; }
.b-mint { background: var(--mint); color: var(--on-accent); }
.b-coral { background: var(--coral); color: var(--on-accent); }
.group { border-top: 1px solid var(--hairline); padding: 6px 0; }
.group-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 40px; cursor: pointer; }
.group-name { font-weight: 600; }
.group-unstage { margin-left: auto; }
.song { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 8px 0 8px 16px; }
.song-text { display: flex; flex-direction: column; min-width: 0; }
.song-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 11px; color: var(--text-faint); }
@media (max-width: 640px) {
  .song { grid-template-columns: minmax(0, 1fr) auto; padding-left: 0; }
  .song .meta { display: none; }
}
</style>
