<script setup lang="ts">
import type { RowState } from '~~/shared/types'

const props = defineProps<{ state: RowState }>()
const badge = computed(() => ({
  add: { glyph: '+', cls: 'badge-mint', label: 'Add' },
  review: { glyph: '?', cls: 'badge-amber', label: 'Review needed' },
  pending: { glyph: '…', cls: 'badge-pending', label: 'Not checked yet' },
  unmatched: { glyph: '∅', cls: 'badge-outline', label: 'Unmatched' },
  in_sync: { glyph: '=', cls: 'badge-synced', label: 'In sync' },
}[props.state]))
</script>

<template>
  <span class="badge" :class="badge.cls" role="img" :aria-label="badge.label">{{ badge.glyph }}</span>
</template>

<style scoped>
.badge { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; font-weight: 700; font-size: 15px; flex: none; }
.badge-mint { background: var(--mint); color: var(--on-accent); }
.badge-amber { background: var(--amber); color: var(--on-accent); }
.badge-pending { border: 1.5px dashed var(--hairline-strong); color: var(--text-muted); }
.badge-outline { border: 1.5px solid var(--hairline-strong); color: var(--text-muted); }
.badge-synced { border: 1.5px solid var(--hairline); color: var(--text-faint); font-size: 13px; }
</style>
