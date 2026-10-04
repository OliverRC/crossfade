<script setup lang="ts">
// Staged (docs/decisions/0007): what the next push to each service will do, and the only place a push starts.
// Removals are listed apart from adds so they are always seen before anything is written, and Push asks once more.
import type { ConnectionView, ProviderId, PushStepProgress, StagedCollectionView, StagedTrackView, StagedView } from '~~/shared/types'

const { data: connections } = await useFetch<ConnectionView[]>('/api/connections')
const { data: view, refresh } = await useFetch<StagedView>('/api/staged')
const actionError = ref<string | null>(null)
const progress = useRunProgress(() => refresh())
const running = computed(() => progress.value?.running ?? false)
/** The service whose push is waiting for a second press. */
const confirming = ref<ProviderId | null>(null)

const names = { spotify: 'Spotify', tidal: 'Tidal' } as const
const PROVIDERS = ['spotify', 'tidal'] as const
/** Services push can write to so far (M5 slice 2: Tidal). */
const PUSHABLE: ProviderId[] = ['spotify', 'tidal']
const NOT_YET = 'This service cannot be pushed to yet. Staging is saved until then.'
/** The service is rate limited: nothing may be sent until it clears. */
const blockedUntil = (p: ProviderId) => {
  const q = connections.value?.find(c => c.provider === p)?.quota
  return q?.blocked ? q.retryAt : null
}
const total = computed(() => PROVIDERS.reduce((n, p) => n + (view.value?.[p].add ?? 0) + (view.value?.[p].remove ?? 0), 0))
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`
const fmtDuration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`
const withRemovals = (p: ProviderId) => (view.value?.[p].collections ?? []).filter(c => c.remove.length)
const withAdds = (p: ProviderId) => (view.value?.[p].collections ?? []).filter(c => c.add.length)

/** Staged songs in playlists the service does not have yet: they wait for playlist creation. */
const waitingForCreate = (p: ProviderId) => (view.value?.[p].collections ?? []).filter(c => c.createsPlaylist).reduce((n, c) => n + c.add.length, 0)
const failedIn = (p: ProviderId) => (view.value?.[p].collections ?? []).reduce((n, c) => n + [...c.add, ...c.remove].filter(t => t.error).length, 0)

async function push(p: ProviderId) {
  actionError.value = null
  confirming.value = null
  try {
    await $fetch(`/api/push/${p}`, { method: 'POST' })
  } catch (e: any) {
    actionError.value = e?.data?.statusMessage ?? 'The push did not start'
  }
}

/** This collection's step in the running or last push to the service. */
const stepOf = (p: ProviderId, c: StagedCollectionView, change: 'add' | 'remove'): PushStepProgress | undefined =>
  progress.value?.push?.provider === p ? progress.value.push.collections[c.key]?.[change] : undefined
const STEP_TEXT: Record<PushStepProgress['status'], string> = { waiting: 'waiting', running: 'pushing…', done: 'pushed', failed: 'failed', skipped: 'waiting for playlist creation' }
const tried = (t: StagedTrackView) => (t.attempts === 1 ? 'tried once' : `tried ${t.attempts} times`)

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

    <div v-if="!running && progress?.push && progress.runId" class="banner" :class="progress.phase === 'failed' ? 'error' : 'ok'" role="status">
      {{ progress.message }} <NuxtLink :to="`/activity/${progress.runId}`">See what it did</NuxtLink>
    </div>
    <div v-else-if="running && progress?.phase === 'push'" class="banner pause" role="status">{{ progress.message }}…</div>

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
            <button type="button" class="pill small" :disabled="running" @click="unstage({ provider: p })">Unstage all</button>
            <button
              type="button" class="pill small solid-coral" :disabled="!PUSHABLE.includes(p) || running || Boolean(blockedUntil(p))"
              :title="running ? 'A pull or push is running; push when it finishes' : blockedUntil(p) ? `${names[p]} is rate limited until ${formatWhen(blockedUntil(p)!)}` : PUSHABLE.includes(p) ? '' : NOT_YET"
              @click="confirming = p"
            >{{ running && progress?.provider === p ? 'Pushing…' : `Push to ${names[p]}` }}</button>
          </div>
        </div>

        <div v-if="confirming === p" class="confirm" role="alertdialog" :aria-label="`Confirm push to ${names[p]}`">
          <p>
            <strong>Write to {{ names[p] }} now?</strong>
            This adds {{ plural(view[p].add - waitingForCreate(p), 'song') }}<template v-if="view[p].remove"> and <strong class="coral-text">removes {{ plural(view[p].remove, 'song') }}</strong> (listed below)</template>.
            Each playlist is read again first and only what it still needs is written. Songs that fail stay staged with the reason.
          </p>
          <p v-if="view[p].needsLookup" class="muted">
            {{ plural(view[p].needsLookup, 'song') }} {{ view[p].needsLookup === 1 ? 'needs' : 'need' }} looking up on {{ names[p] }} by ISRC.
            <template v-if="view[p].lookupBudget !== null">
              {{ names[p] }}'s quota is unpublished and a breach locks it for 13 to 18 hours, so one push spends at most {{ view[p].lookupBudget }} lookup requests
              (1 ISRC each, or 5 if {{ names[p] }} search accepts OR). Songs not looked up stay staged for the next push.
            </template>
          </p>
          <p v-if="waitingForCreate(p)" class="muted">{{ plural(waitingForCreate(p), 'song') }} in playlists {{ names[p] }} does not have yet will wait: creating playlists comes in a later step.</p>
          <div class="confirm-actions">
            <button type="button" class="pill small solid-coral" @click="push(p)">Push now</button>
            <button type="button" class="pill small" @click="confirming = null">Cancel</button>
          </div>
        </div>
        <p v-if="failedIn(p) && !running" class="mono failed-note">! {{ plural(failedIn(p), 'song') }} failed on the last push and {{ failedIn(p) === 1 ? 'is' : 'are' }} still staged; the reason is under each one.</p>

        <div v-if="view[p].remove" class="block removals">
          <h3 class="block-title"><span class="badge b-coral" aria-hidden="true">−</span>Remove from {{ names[p] }} · {{ plural(view[p].remove, 'song') }}</h3>
          <div v-for="c in withRemovals(p)" :key="`r-${c.key}`" class="group">
            <div class="group-head">
              <span class="group-name">{{ c.name }}</span>
              <span v-if="where(c)" class="label">{{ where(c) }}</span>
              <span v-if="stepOf(p, c, 'remove')" class="mono step" :class="stepOf(p, c, 'remove')!.status">{{ STEP_TEXT[stepOf(p, c, 'remove')!.status] }}</span>
            </div>
            <div v-for="t in c.remove" :key="t.canonicalTrackId" class="song">
              <div class="song-text">
                <span class="song-title">{{ t.title }}</span>
                <span class="muted">{{ t.artists.join(', ') }}</span>
                <span v-if="t.error" class="mono error-text">! {{ t.error }} · {{ tried(t) }}</span>
              </div>
              <span class="mono meta">{{ [fmtDuration(t.durationMs), t.isrc].filter(Boolean).join(' · ') }}</span>
              <button type="button" class="pill small" @click="unstage({ collection: c.key, track: t.canonicalTrackId, provider: p })" :disabled="running">Unstage</button>
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
              <span v-if="stepOf(p, c, 'add')" class="mono step" :class="stepOf(p, c, 'add')!.status">{{ STEP_TEXT[stepOf(p, c, 'add')!.status] }}</span>
              <button type="button" class="pill small group-unstage" :disabled="running" @click.prevent="unstage({ collection: c.key, provider: p })">Unstage playlist</button>
            </summary>
            <div v-for="t in c.add" :key="t.canonicalTrackId" class="song">
              <div class="song-text">
                <span class="song-title">{{ t.title }}</span>
                <span class="muted">{{ t.artists.join(', ') }}</span>
                <span v-if="t.error" class="mono error-text">! {{ t.error }} · {{ tried(t) }}</span>
              </div>
              <span class="mono meta">{{ [fmtDuration(t.durationMs), t.isrc].filter(Boolean).join(' · ') }}</span>
              <button type="button" class="pill small" @click="unstage({ collection: c.key, track: t.canonicalTrackId, provider: p })" :disabled="running">Unstage</button>
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
.confirm { margin-top: 16px; padding: 16px; border-radius: var(--radius-row); border: 1.5px solid var(--coral); background: rgba(255, 68, 56, 0.08); line-height: 1.5; }
.confirm p { margin: 0 0 8px; }
.confirm-actions { display: flex; gap: 8px; margin-top: 12px; }
.coral-text { color: var(--coral); }
.failed-note { margin: 12px 0 0; font-size: 12px; color: #ffb3ad; }
.error-text { font-size: 11px; color: #ffb3ad; overflow-wrap: anywhere; }
.step { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
.step.done { color: var(--mint); }
.step.failed { color: var(--coral); }
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
