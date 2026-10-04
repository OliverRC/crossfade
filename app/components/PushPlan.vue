<script setup lang="ts">
// What a push to one service would do for one collection, as numbered steps (docs/decisions/0007): create the
// playlist if the service lacks it, add songs, remove songs. Each step shows how much of it is staged and stages
// on its own; "Stage all" stages the whole plan. Push progress (M5 slice 2) will report against these steps.
import type { CollectionStatusView, ProviderId } from '~~/shared/types'

type Change = 'add' | 'remove'
const props = defineProps<{
  provider: ProviderId
  collection: CollectionStatusView
  /** The playlist is not on the service: push creates it before adding. */
  createsPlaylist: boolean
  /** A same-named collection already on the service: creating this one would make a second copy. */
  namesake?: { key: string, songs: number }
  disabled?: boolean
}>()
const emit = defineEmits<{ stage: [change: Change | undefined, staged: boolean], show: [key: string] }>()

const names = { spotify: 'Spotify', tidal: 'Tidal' } as const
const other = computed(() => names[props.provider === 'spotify' ? 'tidal' : 'spotify'])
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`
const owner = computed(() => {
  const shared = props.collection.shared[props.provider]
  return shared?.access === 'collaborative' ? shared.ownerName ?? 'someone else' : null
})

interface Step { change: Change, verb: string, total: number, staged: number }
const steps = computed<Step[]>(() => {
  const c = props.collection.counts
  const p = props.provider
  return [
    { change: 'add' as const, verb: 'Add', total: c.add[p], staged: c.staged.add[p] },
    { change: 'remove' as const, verb: 'Remove', total: c.remove[p], staged: c.staged.remove[p] },
  ].filter(s => s.total > 0)
})
const total = computed(() => steps.value.reduce((n, s) => n + s.total, 0))
const stagedTotal = computed(() => steps.value.reduce((n, s) => n + s.staged, 0))
const allStaged = computed(() => total.value > 0 && stagedTotal.value === total.value)

/** ○ nothing staged, ◐ some, ● all; the words carry the same so colour and shape are never the only signal. */
const mark = (staged: number, of: number) => (staged === 0 ? { glyph: '○', label: 'not staged' } : staged < of ? { glyph: '◐', label: 'partly staged' } : { glyph: '●', label: 'staged' })
const createMark = computed(() => mark(props.collection.counts.staged.add[props.provider] > 0 ? 1 : 0, 1))
</script>

<template>
  <section class="plan" :aria-label="`Push to ${names[provider]}`">
    <header class="plan-head">
      <span class="label plan-title"><ServiceIcon :provider="provider" :size="12" /> Push to {{ names[provider] }}</span>
      <span v-if="owner" class="mono note">{{ owner }}'s playlist: a push edits theirs</span>
      <span class="mono plan-count">{{ stagedTotal.toLocaleString('en-GB') }} / {{ total.toLocaleString('en-GB') }} staged</span>
      <button type="button" class="pill small" :class="allStaged ? 'outline-dark' : 'solid-black'" :disabled="disabled" @click="emit('stage', undefined, !allStaged)">
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
      <li v-for="s in steps" :key="s.change" class="step">
        <span class="mark" :aria-label="mark(s.staged, s.total).label">{{ mark(s.staged, s.total).glyph }}</span>
        <div class="step-text">
          <span>{{ s.verb }} {{ plural(s.total, 'song') }}</span>
          <span v-if="s.change === 'add' && collection.counts.addUnavailable[provider]" class="mono sub">
            ⊘ {{ collection.counts.addUnavailable[provider] }} unavailable on {{ other }}; push will still look for {{ collection.counts.addUnavailable[provider] === 1 ? 'it' : 'them' }} on {{ names[provider] }}
          </span>
        </div>
        <span class="mono step-count">{{ s.staged.toLocaleString('en-GB') }} staged</span>
        <!-- With one step, Stage all already stages it. -->
        <button v-if="steps.length > 1" type="button" class="pill small" :class="s.staged === s.total ? 'outline-dark' : 'solid-black'" :disabled="disabled" @click="emit('stage', s.change, s.staged !== s.total)">
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
.link { padding: 0; border: 0; background: none; font: inherit; text-decoration: underline; cursor: pointer; color: inherit; }
@media (max-width: 640px) {
  .step { grid-template-columns: 22px 24px minmax(0, 1fr) auto; }
  .step-count { display: none; }
}
</style>
