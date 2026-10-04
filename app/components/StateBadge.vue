<script setup lang="ts">
import type { RowState } from '~~/shared/types'

const props = defineProps<{ state: RowState }>()
const BADGES: Record<RowState, { glyph: string, cls: string, label: string }> = {
  add: { glyph: '+', cls: 'badge-mint', label: 'To add on a service' },
  remove: { glyph: '−', cls: 'badge-coral', label: 'To remove from a service' },
  conflict: { glyph: '?', cls: 'badge-amber', label: 'Conflict: your decision' },
  unavailable: { glyph: '⊘', cls: 'badge-outline', label: 'Unavailable on a service' },
  unknown: { glyph: '…', cls: 'badge-pending', label: 'Service not pulled yet' },
  in_sync: { glyph: '=', cls: 'badge-synced', label: 'In sync' },
}
const badge = computed(() => BADGES[props.state])
</script>

<template>
  <span class="badge" :class="badge.cls" role="img" :aria-label="badge.label">{{ badge.glyph }}</span>
</template>

<style scoped>
.badge { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; font-weight: 700; font-size: 15px; flex: none; }
.badge-mint { background: var(--mint); color: var(--on-accent); }
.badge-coral { background: var(--coral); color: var(--on-accent); }
.badge-amber { background: var(--amber); color: var(--on-accent); }
.badge-pending { border: 1.5px dashed var(--hairline-strong); color: var(--text-muted); }
.badge-outline { border: 1.5px solid var(--hairline-strong); color: var(--text-muted); }
.badge-synced { border: 1.5px solid var(--hairline); color: var(--text-faint); font-size: 13px; }
</style>
