<script setup lang="ts">
// What a push to one service would do for one collection, as numbered steps (docs/decisions/0007): create the
// playlist if the service lacks it, add songs, remove songs. Each step shows how much of it is staged and stages
// on its own; "Stage all" stages the whole plan. While a push runs, and after it, each step shows how it went.
import type { CollectionStatusView, ProviderId, PushStepProgress } from '~~/shared/types'

type Change = 'add' | 'remove'
const props = defineProps<{
  provider: ProviderId
  collection: CollectionStatusView
  /** The playlist is not on the service: push creates it before adding. */
  createsPlaylist: boolean
  /** A same-named collection already on the service: creating this one would make a second copy. */
  namesake?: { key: string, songs: number }
  disabled?: boolean
  /** The running or last push of this collection to this service, step by step. */
  progress?: { add?: PushStepProgress, remove?: PushStepProgress }
}>()
const emit = defineEmits<{ stage: [change: Change | undefined, staged: boolean], show: [key: string] }>()

const names = { spotify: 'Spotify', tidal: 'Tidal' } as const
const other = computed(() => names[props.provider === 'spotify' ? 'tidal' : 'spotify'])
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`
const owner = computed(() => {
  const shared = props.collection.shared[props.provider]
  return shared?.access === 'collaborative' ? shared.ownerName ?? 'someone else' : null
})

interface Step { change: Change, verb: string, past: string, total: number, staged: number, progress?: PushStepProgress }
const steps = computed<Step[]>(() => {
  const c = props.collection.counts
  const p = props.provider
  // A step the last push finished stays visible with its result, even once nothing is left to do.
  return [
    { change: 'add' as const, verb: 'Add', past: 'Added', total: c.add[p], staged: c.staged.add[p], progress: props.progress?.add },
    { change: 'remove' as const, verb: 'Remove', past: 'Removed', total: c.remove[p], staged: c.staged.remove[p], progress: props.progress?.remove },
  ].filter(s => s.total > 0 || s.progress)
})
const pushing = computed(() => [props.progress?.add, props.progress?.remove].some(s => s?.status === 'running' || s?.status === 'waiting'))
const stageable = computed(() => steps.value.filter(s => s.total > 0))
const total = computed(() => steps.value.reduce((n, s) => n + s.total, 0))
const stagedTotal = computed(() => steps.value.reduce((n, s) => n + s.staged, 0))
const allStaged = computed(() => total.value > 0 && stagedTotal.value === total.value)

/** ○ nothing staged, ◐ some, ● all; the words carry the same so colour and shape are never the only signal. */
const mark = (staged: number, of: number) => (staged === 0 ? { glyph: '○', label: 'not staged' } : staged < of ? { glyph: '◐', label: 'partly staged' } : { glyph: '●', label: 'staged' })
const createMark = computed(() => mark(props.collection.counts.staged.add[props.provider] > 0 ? 1 : 0, 1))

/** A push's state for a step, when there is one; it replaces the staging mark. */
const PUSH_MARK: Record<PushStepProgress['status'], { glyph: string, label: string }> = {
  waiting: { glyph: '…', label: 'waiting to push' },
  running: { glyph: '⟳', label: 'pushing' },
  done: { glyph: '✓', label: 'pushed' },
  failed: { glyph: '!', label: 'failed' },
  skipped: { glyph: '–', label: 'not pushed yet' },
}
function stepMark(s: Step) {
  return s.progress ? PUSH_MARK[s.progress.status] : mark(s.staged, s.total)
}
/** What a push did for a step, in words; the reason for the first failure follows. */
function outcome(s: Step): string | null {
  const p = s.progress
  if (!p) return null
  if (p.status === 'waiting') return `${plural(p.total, 'song')} waiting`
  if (p.status === 'running') return `Pushing ${p.total.toLocaleString('en-GB')} songs…`
  if (p.status === 'skipped') return p.detail
  return [p.done ? `${s.past} ${plural(p.done, 'song')}` : null, p.failed ? `${p.failed} failed and still staged` : null].filter(Boolean).join(' · ') || 'Nothing written'
}
</script>

<template>
  <section class="plan" :aria-label="`Push to ${names[provider]}`">
    <header class="plan-head">
      <span class="label plan-title"><ServiceIcon :provider="provider" :size="12" /> Push to {{ names[provider] }}</span>
      <span v-if="owner" class="mono note">{{ owner }}'s playlist: a push edits theirs</span>
      <span v-if="total" class="mono plan-count">{{ stagedTotal.toLocaleString('en-GB') }} / {{ total.toLocaleString('en-GB') }} staged</span>
      <span v-else class="mono plan-count">In sync with main</span>
      <button v-if="total" type="button" class="pill small" :class="allStaged ? 'outline-dark' : 'solid-black'" :disabled="disabled || pushing" @click="emit('stage', undefined, !allStaged)">
        {{ allStaged ? 'Unstage all' : 'Stage all' }}
      </button>
    </header>
    <ol class="steps">
      <li v-if="createsPlaylist" class="step">
        <span class="mark" :title="`Runs with the first staged add: ${createMark.label}`" :aria-label="createMark.label">{{ createMark.glyph }}</span>
        <div class="step-text">
          <span>Create playlist "{{ collection.name }}"</span>
          <span v-if="namesake" class="mono sub warn">
            ≠ Another "{{ collection.name }}" ({{ plural(namesake.songs, 'song') }}) is already on {{ names[provider] }}: this makes a second one.
            <button type="button" class="link" @click="emit('show', namesake.key)">Show it</button>
          </span>
          <span v-else class="mono sub">Happens with the first staged add</span>
        </div>
      </li>
      <li v-for="s in steps" :key="s.change" class="step" :class="s.progress?.status">
        <span class="mark" :aria-label="stepMark(s).label" :title="stepMark(s).label">{{ stepMark(s).glyph }}</span>
        <div class="step-text">
          <span>{{ s.verb }} {{ plural(s.total || s.progress?.total || 0, 'song') }}</span>
          <span v-if="outcome(s)" class="mono sub result">{{ outcome(s) }}</span>
          <span v-if="s.progress?.failed && s.progress.detail" class="mono sub">! {{ s.progress.detail }}</span>
          <span v-if="s.change === 'add' && collection.counts.addUnavailable[provider]" class="mono sub">
            ⊘ {{ collection.counts.addUnavailable[provider] }} unavailable on {{ other }}; push will still look for {{ collection.counts.addUnavailable[provider] === 1 ? 'it' : 'them' }} on {{ names[provider] }}
          </span>
        </div>
        <span v-if="s.total" class="mono step-count">{{ s.staged.toLocaleString('en-GB') }} staged</span>
        <!-- With one step, Stage all already stages it. -->
        <button v-if="stageable.length > 1 && s.total" type="button" class="pill small" :class="s.staged === s.total ? 'outline-dark' : 'solid-black'" :disabled="disabled || pushing" @click="emit('stage', s.change, s.staged !== s.total)">
          {{ s.staged === s.total ? 'Unstage' : 'Stage' }}
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.plan { padding: 12px 14px; border-radius: var(--radius-row); background: rgba(0, 0, 0, 0.08); }
.plan-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
.plan-title { display: inline-flex; align-items: center; gap: 6px; color: var(--on-accent); font-weight: 700; }
.note { font-size: 11px; }
.plan-count { margin-left: auto; font-size: 11px; }
.steps { list-style: none; margin: 8px 0 0; padding: 0; counter-reset: step; }
.step { display: grid; grid-template-columns: 22px 28px minmax(0, 1fr) auto auto; align-items: center; gap: 4px 10px; padding: 6px 0; border-top: 1px solid rgba(0, 0, 0, 0.12); counter-increment: step; font-size: 14px; }
.step::before { content: counter(step); font-family: var(--mono); font-size: 12px; opacity: 0.6; grid-column: 1; grid-row: 1; }
.mark { grid-column: 2; font-size: 16px; line-height: 1; }
.step-text { grid-column: 3; display: flex; flex-direction: column; min-width: 0; }
.sub { font-size: 11px; opacity: 0.75; }
.warn { opacity: 1; }
.step-count { font-size: 11px; }
.step.running .mark { animation: spin 1.2s linear infinite; display: inline-block; }
.step.failed .mark { color: var(--coral); font-weight: 700; }
.result { opacity: 1; font-weight: 600; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .step.running .mark { animation: none; } }
.link { padding: 0; border: 0; background: none; font: inherit; text-decoration: underline; cursor: pointer; color: inherit; }
@media (max-width: 640px) {
  .step { grid-template-columns: 22px 24px minmax(0, 1fr) auto; }
  .step-count { display: none; }
}
</style>
