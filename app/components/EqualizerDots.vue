<script setup lang="ts">
// Dot-matrix equalizer: 7 rows, each column lit from the bottom in proportion to its value.
const props = withDefaults(defineProps<{ values: number[], columns?: number, animate?: boolean }>(), { columns: 20, animate: false })
const ROWS = 7

const lit = computed(() => {
  const values = props.values.slice(-props.columns)
  const padded = [...Array(Math.max(0, props.columns - values.length)).fill(0), ...values]
  const max = Math.max(1, ...padded)
  return padded.map(v => (v > 0 ? Math.max(1, Math.round((v / max) * ROWS)) : 0))
})
</script>

<template>
  <div class="eq" :class="{ animate }" :style="{ gridTemplateColumns: `repeat(${columns}, 1fr)` }" aria-hidden="true">
    <div v-for="(height, col) in lit" :key="col" class="col" :style="{ animationDelay: `${(col % 7) * 90}ms` }">
      <span v-for="row in ROWS" :key="row" class="d" :class="{ on: ROWS - row < height }" />
    </div>
  </div>
</template>

<style scoped>
.eq { display: grid; gap: 4px; }
.col { display: grid; grid-template-rows: repeat(7, 1fr); gap: 4px; }
.d { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: 0.14; justify-self: center; }
.d.on { opacity: 1; }
.animate .col { animation: bounce 900ms ease-in-out infinite alternate; }
@keyframes bounce { from { clip-path: inset(0 0 0 0); } to { clip-path: inset(45% 0 0 0); } }
</style>
