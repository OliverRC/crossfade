<script setup lang="ts">
import type { ConnectionView } from '~~/shared/types'

const route = useRoute()
const { data: connections, refresh } = await useFetch<ConnectionView[]>('/api/connections')

const names = { spotify: 'Spotify', tidal: 'Tidal' } as const

async function disconnect(provider: string) {
  if (!confirm(`Disconnect ${provider}? Matches and history are kept; only the tokens are removed.`)) return
  await $fetch(`/api/connections/${provider}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <main class="page">
    <AppHeader :connections="connections ?? []" />
    <div v-if="route.query.error" class="banner error" role="alert">{{ route.query.error }}</div>
    <div v-else-if="route.query.connected" class="banner ok">{{ names[route.query.connected as 'spotify' | 'tidal'] ?? route.query.connected }} connected.</div>

    <h1 class="display title">Connections</h1>
    <p class="muted intro">Crossfade reads and writes your library through each service's own sign-in. Tokens are encrypted at rest.</p>

    <div class="grid">
      <section v-for="c in connections" :key="c.provider" class="card">
        <div class="head">
          <span class="dot" :class="c.provider" />
          <h2 class="display name">{{ names[c.provider] }}</h2>
          <span class="pill small" :class="c.needsReconnect ? 'solid-coral' : c.connected ? 'solid-mint' : 'dashed'">
            {{ c.needsReconnect ? 'Needs reconnect' : c.connected ? 'Connected' : 'Not connected' }}
          </span>
        </div>

        <dl>
          <template v-if="c.connected">
            <dt class="label">Account</dt><dd class="mono">{{ c.providerUserId }}</dd>
            <dt class="label">Scopes</dt><dd class="mono small">{{ c.scopes.join(' ') || 'not reported' }}</dd>
          </template>
          <dt class="label">Redirect URI</dt><dd class="mono small">{{ c.redirectUri }}</dd>
        </dl>

        <p v-if="!c.configured" class="banner error">
          Set <code>{{ c.provider.toUpperCase() }}_CLIENT_ID</code> in <code>.env</code> and restart, then connect.
        </p>
        <div class="actions">
          <a v-if="c.configured" class="pill solid-mint" :href="`/auth/${c.provider}`">{{ c.connected ? 'Reconnect' : `Connect ${names[c.provider]}` }}</a>
          <button v-if="c.connected" class="pill" type="button" @click="disconnect(c.provider)">Disconnect</button>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.title { font-size: clamp(28px, 5vw, 44px); margin-top: 8px; }
.intro { max-width: 60ch; margin: 12px 0 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.head { display: flex; align-items: center; gap: 12px; }
.name { font-size: 22px; flex: 1; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 20px 0; align-items: baseline; }
dd { margin: 0; overflow-wrap: anywhere; }
.small { font-size: 12px; color: var(--text-muted); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
code { font-family: var(--mono); }
</style>
