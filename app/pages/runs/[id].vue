<script setup lang="ts">
import type { ConnectionView, RunDetail, RunEvent, StageKey } from '~~/shared/types'
import { STAGES } from '~~/shared/types'

const route = useRoute()
const { data: connections } = await useFetch<ConnectionView[]>('/api/connections')
const { data: run, refresh, error } = await useFetch<RunDetail>(() => `/api/runs/${route.params.id}`)

// Live: the server bumps `rev` on every stage change or event; refetch at most once a second.
const progress = useSyncProgress(() => refresh())
let pending: ReturnType<typeof setTimeout> | null = null
watch(() => progress.value?.rev, () => {
  if (progress.value?.runId !== run.value?.id) return
  pending ??= setTimeout(() => { pending = null; refresh() }, 1000)
})
const now = useNow(1000)

const live = computed(() => run.value?.status === 'running' && progress.value?.runId === run.value?.id && progress.value?.running)
const stageLabel = Object.fromEntries(STAGES.map(s => [s.key, s.label])) as Record<StageKey, string>
const issues = computed(() => (run.value?.events ?? []).filter(e => e.level !== 'info'))
const filter = ref<'all' | StageKey>('all')
const events = computed(() => [...(run.value?.events ?? [])].reverse().filter(e => filter.value === 'all' || e.stage === filter.value))
const elapsed = computed(() => run.value && formatSpan((run.value.finishedAt ? Date.parse(run.value.finishedAt) : now.value) - Date.parse(run.value.startedAt)))
const levelGlyph: Record<RunEvent['level'], string> = { info: '·', warn: '‖', error: '!' }
const n = (k: string) => (run.value?.counts?.[k] ?? 0).toLocaleString('en-GB')

async function resume() {
  await $fetch('/api/sync', { method: 'POST' }).catch(() => {})
  await refresh()
}
</script>

<template>
  <main class="page">
    <AppHeader :connections="connections ?? []" />
    <NuxtLink to="/runs" class="back mono">← All runs</NuxtLink>

    <p v-if="error" class="banner error">That run does not exist.</p>
    <template v-else-if="run">
      <section class="card head">
        <div class="head-top">
          <h1 class="display title">Sync #{{ run.id }}</h1>
          <span class="pill small" :class="runStatusPill[run.status].cls">{{ live ? 'Running now' : runStatusPill[run.status].label }}</span>
          <button v-if="run.status === 'paused' || run.status === 'failed'" type="button" class="pill small" @click="resume">Resume now</button>
        </div>
        <div class="mono meta">
          <span>Started {{ formatWhen(run.startedAt) }} {{ run.trigger === 'schedule' ? 'automatically' : 'by you' }}</span>
          <span>{{ run.finishedAt ? `Finished ${formatWhen(run.finishedAt)}` : `${elapsed} so far` }}</span>
          <span>{{ run.attempts === 1 ? '1 attempt' : `${run.attempts} attempts` }}</span>
          <span class="req"><ServiceIcon provider="spotify" :size="12" /> {{ n('spotifyRequests') }} requests</span>
          <span class="req"><ServiceIcon provider="tidal" :size="12" /> {{ n('tidalRequests') }} requests</span>
        </div>
        <div class="bar"><span :style="{ width: `${Math.round(runProgress(run) * 100)}%` }" :class="run.status" /></div>
        <p v-if="live && progress?.message" class="mono now">{{ progress.message }}<template v-if="progress.total"> · {{ progress.done }}/{{ progress.total }}</template></p>
        <p v-if="run.status === 'paused' && run.pause" class="banner pause">
          <strong>Paused:</strong> {{ run.pause.message }}. Resumes automatically at {{ formatWhen(run.pause.resumeAt) }}
          (in {{ formatSpan(Date.parse(run.pause.resumeAt) - now) }}). Everything done so far is saved.
        </p>
        <p v-if="run.status === 'failed' && run.error" class="banner error">
          <strong>Stopped:</strong> {{ run.error }}. Everything done so far is saved; Resume picks up from here.
        </p>
      </section>

      <div class="grid">
        <section class="card">
          <h2 class="label section-title">Stages</h2>
          <ol class="stages">
            <li v-for="s in STAGES" :key="s.key" class="stage" :class="run.stages[s.key]?.status ?? 'waiting'">
              <StageGlyph :status="run.stages[s.key]?.status ?? 'waiting'" />
              <div class="stage-body">
                <div class="stage-top">
                  <span class="stage-name">
                    <ServiceIcon v-if="s.key.endsWith('spotify')" provider="spotify" :size="14" />
                    <ServiceIcon v-else-if="s.key.endsWith('tidal')" provider="tidal" :size="14" />
                    {{ s.label }}
                  </span>
                  <span class="mono stage-time">
                    <template v-if="run.stages[s.key]?.total">{{ run.stages[s.key]!.done.toLocaleString('en-GB') }} / {{ run.stages[s.key]!.total.toLocaleString('en-GB') }} · </template>
                    {{ stageDuration(run.stages[s.key] ?? { status: 'waiting', startedAt: null, finishedAt: null, done: 0, total: 0, detail: null }, now) ?? 'waiting' }}
                  </span>
                </div>
                <div v-if="run.stages[s.key]?.total" class="bar thin">
                  <span :style="{ width: `${Math.round((run.stages[s.key]!.done / run.stages[s.key]!.total) * 100)}%` }" :class="run.stages[s.key]!.status" />
                </div>
                <p class="mono stage-detail">{{ run.stages[s.key]?.detail ?? s.help }}</p>
              </div>
            </li>
          </ol>
        </section>

        <div class="side">
          <section class="card">
            <h2 class="label section-title">Issues</h2>
            <p v-if="!issues.length" class="muted small">None so far.</p>
            <ul class="events">
              <li v-for="e in issues" :key="e.id" class="event" :class="e.level">
                <span class="mono t">{{ clock(e.at) }}</span>
                <span class="lvl" aria-hidden="true">{{ levelGlyph[e.level] }}</span>
                <span>{{ e.message }}</span>
              </li>
            </ul>
          </section>

          <section class="card">
            <div class="log-head">
              <h2 class="label section-title">Log</h2>
              <select v-model="filter" class="mono" aria-label="Filter by stage">
                <option value="all">All stages</option>
                <option v-for="s in STAGES" :key="s.key" :value="s.key">{{ s.label }}</option>
              </select>
            </div>
            <ul class="events log">
              <li v-for="e in events" :key="e.id" class="event" :class="e.level">
                <span class="mono t">{{ clock(e.at) }}</span>
                <span class="lvl" aria-hidden="true">{{ levelGlyph[e.level] }}</span>
                <span><span v-if="e.stage && filter === 'all'" class="mono tag">{{ stageLabel[e.stage] }}</span>{{ e.message }}</span>
              </li>
            </ul>
            <p v-if="!events.length" class="muted small">Nothing logged{{ filter === 'all' ? '' : ' for this stage' }} yet.</p>
          </section>
        </div>
      </div>
    </template>
  </main>
</template>

<style scoped>
.back { display: inline-block; font-size: 12px; color: var(--text-muted); text-decoration: none; margin: 4px 0 14px; padding: 8px 0; }
.head { display: grid; gap: 14px; }
.head-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.title { font-size: clamp(26px, 4.5vw, 40px); }
.meta { display: flex; gap: 6px 20px; flex-wrap: wrap; font-size: 12px; color: var(--text-muted); }
.req { display: inline-flex; align-items: center; gap: 6px; }
.now { margin: 0; font-size: 12px; color: var(--mint); }
.head .banner { margin: 0; }
.bar { height: 6px; border-radius: 999px; background: var(--raised); overflow: hidden; }
.bar.thin { height: 3px; margin-top: 8px; }
.bar span { display: block; height: 100%; background: var(--mint); transition: width 400ms ease; }
.bar span.paused { background: var(--amber); }
.bar span.failed { background: var(--coral); }

.grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 16px; margin-top: 16px; align-items: start; }
.side { display: grid; gap: 16px; }
.section-title { margin: 0 0 16px; }

.stages { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.stage { display: flex; gap: 14px; padding: 12px; border-radius: var(--radius-row); }
.stage.running { background: rgba(212, 245, 207, 0.06); }
.stage.paused { background: rgba(242, 184, 75, 0.08); }
.stage.failed { background: rgba(255, 68, 56, 0.08); }
.stage.waiting .stage-name { color: var(--text-muted); }
.stage-body { flex: 1; min-width: 0; }
.stage-top { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.stage-name { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.stage-time { font-size: 11px; color: var(--text-faint); }
.stage-detail { margin: 6px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; overflow-wrap: anywhere; }

.events { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.events.log { max-height: 560px; overflow-y: auto; }
.event { display: grid; grid-template-columns: 62px 14px 1fr; gap: 8px; padding: 6px 4px; font-size: 13px; line-height: 1.45; border-radius: 8px; }
.event .t { font-size: 11px; color: var(--text-faint); padding-top: 2px; }
.event .lvl { font-weight: 700; color: var(--text-faint); text-align: center; }
.event.warn { color: #f7d79b; }
.event.warn .lvl { color: var(--amber); }
.event.error { color: #ffb3ad; }
.event.error .lvl { color: var(--coral); }
.tag { font-size: 10.5px; color: var(--text-faint); margin-right: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
.log-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
select { background: var(--ground); color: var(--text); border: 1.5px solid var(--hairline-strong); border-radius: 999px; padding: 6px 12px; font-size: 11px; min-height: 32px; }
.small { font-size: 13px; }

@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
