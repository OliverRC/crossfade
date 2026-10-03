<script setup lang="ts">
import type { StageStatus } from '~~/shared/types'

const props = withDefaults(defineProps<{ status: StageStatus, size?: number }>(), { size: 28 })
const glyph = computed(() => ({
  done: { g: '✓', cls: 'done', label: 'Done' },
  running: { g: '▸', cls: 'running', label: 'Running' },
  paused: { g: '‖', cls: 'paused', label: 'Paused' },
  failed: { g: '!', cls: 'failed', label: 'Failed' },
  skipped: { g: '–', cls: 'skipped', label: 'Skipped' },
  waiting: { g: '', cls: 'waiting', label: 'Waiting' },
}[props.status]))
</script>

<template>
  <span class="glyph" :class="glyph.cls" role="img" :aria-label="glyph.label" :style="{ width: `${size}px`, height: `${size}px` }">{{ glyph.g }}</span>
</template>

<style scoped>
.glyph { display: inline-grid; place-items: center; border-radius: 50%; font-weight: 700; font-size: 13px; flex: none; }
.done { background: var(--mint); color: var(--on-accent); }
.running { border: 2px solid var(--mint); color: var(--mint); animation: pulse 1.2s ease-in-out infinite; }
.paused { background: var(--amber); color: var(--on-accent); }
.failed { background: #000; border: 2px solid var(--coral); color: var(--coral); }
.skipped { border: 1.5px solid var(--hairline); color: var(--text-faint); }
.waiting { border: 1.5px dashed var(--hairline-strong); }
@keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(212, 245, 207, 0.15); } }
</style>
