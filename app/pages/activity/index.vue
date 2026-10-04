<script setup lang="ts">
import type { ConnectionView, RunSummary } from '~~/shared/types'
import { stagesFor } from '~~/shared/types'

const { data: connections } = await useFetch<ConnectionView[]>('/api/connections')
const { data: runs, refresh } = await useFetch<RunSummary[]>('/api/runs')
const progress = useRunProgress(() => refresh())
let pending: ReturnType<typeof setTimeout> | null = null
watch(() => progress.value?.rev, () => { pending ??= setTimeout(() => { pending = null; refresh() }, 1000) })

const total = (r: RunSummary, k: string) => (r.counts?.[k] ?? 0).toLocaleString('en-GB')
</script>

<template>
  <main class="page">
    <AppHeader :connections="connections ?? []" />
    <h1 class="display title">Activity</h1>
    <p class="muted intro">Every pull, push and cleanup, newest first. A pull only reads one service and updates main. Entries marked <strong>Wrote to</strong> changed that service's library.</p>

    <p v-if="!runs?.length" class="muted">Nothing yet.</p>
    <div class="list">
      <NuxtLink v-for="r in runs" :key="r.id" :to="`/activity/${r.id}`" class="card run">
        <div class="run-head">
          <span class="display run-id"><ServiceIcon v-if="r.provider" :provider="r.provider" :size="16" /> {{ runTitle(r) }} #{{ r.id }}</span>
          <span class="pill small" :class="runStatusPill[r.status].cls">{{ runStatusPill[r.status].label }}</span>
          <span v-if="r.kind === 'cleanup' || r.kind === 'push'" class="pill small solid-coral">− Wrote to {{ r.provider === 'spotify' ? 'Spotify' : 'Tidal' }}</span>
          <span class="mono muted when">{{ formatWhen(r.startedAt) }} · {{ r.trigger === 'schedule' ? 'automatic' : 'manual' }}<template v-if="r.attempts > 1"> · {{ r.attempts }} attempts</template></span>
        </div>
        <div class="stages" aria-hidden="true">
          <span v-for="s in stagesFor(r)" :key="s.key" class="stage-dot" :class="r.stages[s.key]?.status ?? 'waiting'" :title="s.label" />
          <span class="mono now">{{ activeStage(r)?.label ?? (r.status === 'succeeded' ? 'All stages done' : '') }}<template v-if="r.status === 'paused' && r.pause"> · resumes {{ formatWhen(r.pause.resumeAt) }}</template></span>
        </div>
        <div class="bar"><span :style="{ width: `${Math.round(runProgress(r) * 100)}%` }" :class="r.status" /></div>
        <div class="mono stats">
          <template v-if="r.kind === 'pull'">
            <span>{{ total(r, 'added') }} added</span>
            <span>{{ total(r, 'removed') }} removed</span>
            <span>{{ total(r, 'conflicts') }} conflicts</span>
            <span>{{ total(r, 'held') }} held</span>
          </template>
          <template v-else-if="r.kind === 'push'">
            <span>{{ total(r, 'added') }} added</span>
            <span>{{ total(r, 'removed') }} removed</span>
            <span>{{ total(r, 'failed') }} failed</span>
            <span>{{ total(r, 'skipped') }} waiting</span>
          </template>
          <template v-else-if="r.kind === 'cleanup'">
            <span>{{ total(r, 'merged') }} merged</span>
            <span>{{ total(r, 'deleted') }} deleted</span>
            <span>{{ total(r, 'added') }} songs added</span>
            <span>{{ total(r, 'skipped') }} skipped</span>
            <span>{{ total(r, 'failed') }} failed</span>
          </template>
          <template v-else>
            <span>{{ total(r, 'add') }} adds</span>
            <span>{{ total(r, 'review') }} reviews</span>
            <span>{{ total(r, 'pending') }} not checked</span>
            <span>{{ total(r, 'unmatched') }} unmatched</span>
          </template>
          <span v-if="r.provider !== 'tidal'" class="req"><ServiceIcon provider="spotify" :size="12" /> {{ total(r, 'spotifyRequests') }}</span>
          <span v-if="r.provider !== 'spotify'" class="req"><ServiceIcon provider="tidal" :size="12" /> {{ total(r, 'tidalRequests') }}</span>
        </div>
        <p v-if="r.status === 'failed' && r.error" class="mono error">{{ r.error }}</p>
      </NuxtLink>
    </div>
  </main>
</template>

<style scoped>
.title { font-size: clamp(28px, 5vw, 44px); margin-top: 8px; }
.intro { margin: 12px 0 24px; }
.list { display: grid; gap: 12px; }
.run { display: grid; gap: 14px; text-decoration: none; border: 1.5px solid transparent; }
.run:hover { border-color: var(--hairline-strong); }
.run-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.run-id { font-size: 22px; }
.when { font-size: 12px; }
.stages { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.stage-dot { width: 10px; height: 10px; border-radius: 50%; border: 1.5px dashed var(--hairline-strong); }
.stage-dot.done { background: var(--mint); border: 0; }
.stage-dot.running { border: 2px solid var(--mint); }
.stage-dot.paused { background: var(--amber); border: 0; }
.stage-dot.failed { background: var(--coral); border: 0; }
.stage-dot.skipped { background: var(--hairline); border: 0; }
.now { font-size: 12px; color: var(--text-muted); margin-left: 8px; }
.bar { height: 4px; border-radius: 999px; background: var(--raised); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--mint); }
.bar span.paused { background: var(--amber); }
.bar span.failed { background: var(--coral); }
.stats { display: flex; gap: 6px 18px; flex-wrap: wrap; font-size: 12px; color: var(--text-muted); }
.req { display: inline-flex; align-items: center; gap: 6px; }
.error { margin: 0; font-size: 12px; color: #ffb3ad; overflow-wrap: anywhere; }
</style>
