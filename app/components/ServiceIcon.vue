<script setup lang="ts">
// Service marks, inlined so they need no extra requests. Spotify: the 48 px icon from open.spotify.com's
// favicon. Tidal: the diamond mark from Tidal's developer docs, drawn in currentColor (white on black).
import type { ProviderId } from '~~/shared/types'

withDefaults(defineProps<{ provider: ProviderId, size?: number, dim?: boolean }>(), { size: 16, dim: false })

const SPOTIFY = 'data:image/png;base64,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'
</script>

<template>
  <img v-if="provider === 'spotify'" :src="SPOTIFY" :width="size" :height="size" alt="Spotify" class="icon" :class="{ dim }">
  <svg v-else :width="size" :height="size * 0.667" viewBox="0 0 239.5 159.7" role="img" aria-label="Tidal" class="icon" :class="{ dim }">
    <path fill="currentColor" d="M159.67 39.938l-39.88 39.88-39.88-39.88 39.88-39.88zM159.669 119.756l-39.88 39.88-39.88-39.88 39.88-39.88zM79.809 39.912l-39.88 39.88-39.88-39.88 39.88-39.88zM239.505 39.93l-39.88 39.88-39.88-39.88 39.88-39.88z" />
  </svg>
</template>

<style scoped>
.icon { display: inline-block; flex: none; vertical-align: middle; color: var(--tidal); }
.dim { opacity: 0.3; filter: grayscale(1); }
</style>
