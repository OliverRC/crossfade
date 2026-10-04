<script setup lang="ts">
// The push button follows where changes are waiting to go (docs/decisions/0005): Push to Spotify, Push to Tidal,
// or Push to both as a split button whose menu pushes to one. Push itself arrives in M5.
import type { ProviderId } from '~~/shared/types'

const props = defineProps<{ waiting: Record<ProviderId, number>, small?: boolean, dark?: boolean }>()
const open = ref(false)
const names = { spotify: 'Spotify', tidal: 'Tidal' } as const
const targets = computed(() => (['spotify', 'tidal'] as const).filter(p => props.waiting[p] > 0))
const total = computed(() => targets.value.reduce((n, p) => n + props.waiting[p], 0))
const label = computed(() => (targets.value.length === 2 ? 'Push to both' : `Push to ${names[targets.value[0]!]}`))
const NOT_YET = 'Push arrives in M5. Pull only reads; nothing is written yet.'
</script>

<template>
  <div v-if="targets.length" class="push" :class="{ small }">
    <button type="button" class="pill main" :class="[dark ? 'solid-black' : 'solid-coral', { small }]" disabled :title="NOT_YET">
      <ServiceIcon v-for="p in targets" :key="p" :provider="p" :size="small ? 12 : 14" />
      {{ label }} · {{ total.toLocaleString('en-GB') }}
    </button>
    <button
      v-if="targets.length === 2" type="button" class="pill toggle" :class="[dark ? 'solid-black' : 'solid-coral', { small }]"
      :aria-expanded="open" aria-label="Push to one service" @click="open = !open"
    >▾</button>
    <ul v-if="open && targets.length === 2" class="menu" role="menu">
      <li v-for="p in targets" :key="p" role="none">
        <button type="button" role="menuitem" class="menu-item" disabled :title="NOT_YET">
          <ServiceIcon :provider="p" :size="14" /> Push to {{ names[p] }} · {{ waiting[p].toLocaleString('en-GB') }}
        </button>
      </li>
    </ul>
  </div>
  <span v-else class="pill dashed" :class="{ small }">Both services match main</span>
</template>

<style scoped>
.push { position: relative; display: inline-flex; }
.main { border-top-right-radius: 999px; border-bottom-right-radius: 999px; }
.push:has(.toggle) .main { border-top-right-radius: 0; border-bottom-right-radius: 0; padding-right: 14px; }
.toggle { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 14px; border-left: 1px solid rgba(255, 255, 255, 0.2); cursor: pointer; opacity: 1; }
.solid-coral.toggle { border-left-color: rgba(0, 0, 0, 0.35); }
.menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 5; list-style: none; margin: 0; padding: 6px; border-radius: 16px; background: var(--raised); border: 1px solid var(--hairline-strong); min-width: 220px; }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: 0; border-radius: 10px; background: transparent; color: var(--text); font-family: var(--mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left; cursor: not-allowed; opacity: 0.7; }
</style>
