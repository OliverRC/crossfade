<script setup lang="ts">
import type { ConnectionView } from '~~/shared/types'

const props = defineProps<{ connections?: ConnectionView[] }>()
const { clear } = useUserSession()
const route = useRoute()

const nav = [
  { to: '/', label: 'Library' },
  { to: null, label: 'Review', note: 'M3' },
  { to: null, label: 'Unmatched', note: 'M3' },
  { to: '/cleanup', label: 'Cleanup' },
  { to: '/activity', label: 'Activity' },
  { to: '/connections', label: 'Connections' },
]

const status = (p: 'spotify' | 'tidal') => {
  const c = props.connections?.find(x => x.provider === p)
  if (c?.needsReconnect) return 'needs reconnect'
  if (c?.quota?.blocked) return `rate limited until ${formatWhen(c.quota.retryAt)}`
  return c?.connected ? 'connected' : 'not connected'
}

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <header class="header">
    <NuxtLink to="/" class="logo display">Crossfade</NuxtLink>
    <nav class="nav" aria-label="Main">
      <template v-for="item in nav" :key="item.label">
        <NuxtLink v-if="item.to" :to="item.to" class="nav-link" :class="{ active: item.to === '/' ? route.path === '/' : route.path.startsWith(item.to) }">{{ item.label }}</NuxtLink>
        <span v-else class="nav-link soon" :title="`Arrives in ${item.note}`">{{ item.label }}</span>
      </template>
    </nav>
    <div class="services">
      <NuxtLink v-for="p in (['spotify', 'tidal'] as const)" :key="p" to="/connections" class="pill small" :class="{ limited: status(p).startsWith('rate') }" :title="`${p}: ${status(p)}`">
        <ServiceIcon :provider="p" :size="14" :dim="!['connected'].includes(status(p)) && !status(p).startsWith('rate')" />{{ p }}<span v-if="status(p).startsWith('rate')" class="limited-mark" aria-hidden="true">!</span>
      </NuxtLink>
      <button class="pill small" type="button" @click="logout">Log out</button>
    </div>
  </header>
</template>

<style scoped>
.header { display: flex; align-items: center; gap: 24px; padding: 4px 0 20px; flex-wrap: wrap; }
.logo { font-size: 20px; color: var(--mint); text-decoration: none; }
.nav { display: flex; gap: 22px; flex: 1; justify-content: center; flex-wrap: wrap; }
.nav-link { font-family: var(--mono); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); text-decoration: none; padding: 12px 0; }
.nav-link.active { color: var(--text); }
.nav-link.soon { opacity: 0.45; cursor: default; }
.services { display: flex; gap: 8px; }
.pill.limited { border-color: var(--amber); color: var(--amber); }
.limited-mark { font-weight: 700; }
@media (max-width: 760px) {
  .header { gap: 12px; }
  .nav { order: 3; flex-basis: 100%; justify-content: flex-start; gap: 4px 14px; }
  .nav-link { font-size: 11px; padding: 8px 0; }
}
</style>
