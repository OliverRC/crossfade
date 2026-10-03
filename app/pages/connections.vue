<script setup lang="ts">
import type { ConnectionView } from '~~/shared/types'

const route = useRoute()
const { data: connections, refresh } = await useFetch<ConnectionView[]>('/api/connections')

const names = { spotify: 'Spotify', tidal: 'Tidal' } as const
const now = useNow()

function status(c: ConnectionView) {
  if (c.needsReconnect) return { label: 'Needs reconnect', cls: 'solid-coral' }
  if (c.quota?.blocked) return { label: 'Rate limited', cls: 'solid-amber' }
  if (c.connected) return { label: 'Connected', cls: 'solid-mint' }
  return { label: 'Not connected', cls: 'dashed' }
}

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
          <ServiceIcon :provider="c.provider" :size="26" />
          <h2 class="display name">{{ names[c.provider] }}</h2>
          <span class="pill small" :class="status(c).cls">{{ status(c).label }}</span>
        </div>

        <div v-if="c.quota" class="quota" :class="{ cleared: !c.quota.blocked }" role="status">
          <template v-if="c.quota.blocked">
            <div class="quota-head">
              <span class="label">Rate limit</span>
              <span class="mono quota-countdown">try again in {{ formatSpan(Date.parse(c.quota.retryAt) - now) }}</span>
            </div>
            <p>
              {{ names[c.provider] }} stopped answering<template v-if="c.quota.hitAt"> at {{ formatWhen(c.quota.hitAt) }}</template>.
              Crossfade sends it nothing until <strong>{{ formatWhen(c.quota.retryAt) }}</strong>, then resumes the sync on its own.
            </p>
            <p class="quota-note">
              <template v-if="c.quota.source === 'retry-after'">That time comes from {{ names[c.provider] }} (its Retry-After header).</template>
              <template v-else>{{ names[c.provider] }} gave no reset time, so that is an estimate: Crossfade probes again then, and waits longer if it is still limited. Reported resets take 13 to 18 hours.</template>
            </p>
          </template>
          <template v-else>
            <div class="quota-head">
              <span class="label">Rate limit</span>
              <span class="mono quota-countdown">cleared</span>
            </div>
            <p>Limited<template v-if="c.quota.hitAt"> from {{ formatWhen(c.quota.hitAt) }}</template> until {{ formatWhen(c.quota.retryAt) }}.</p>
          </template>
          <p v-if="c.quota.message" class="mono quota-raw">{{ c.quota.message }}</p>
        </div>

        <dl>
          <template v-if="c.connected">
            <dt class="label">Account</dt><dd class="mono">{{ c.providerUserId }}</dd>
            <dt class="label">Scopes</dt><dd class="mono fine">{{ c.scopes.join(' ') || 'not reported' }}</dd>
            <dt class="label">Requests</dt><dd class="mono fine">{{ c.requestsLastRun ?? 0 }} in the latest sync</dd>
          </template>
          <dt class="label">Redirect URI</dt><dd class="mono fine">{{ c.redirectUri }}</dd>
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
.fine { font-size: 12px; color: var(--text-muted); }
.quota { margin-top: 18px; padding: 14px 16px; border-radius: var(--radius-row); background: rgba(242, 184, 75, 0.1); border: 1px solid rgba(242, 184, 75, 0.4); color: #f7d79b; font-size: 14px; }
.quota.cleared { background: transparent; border-color: var(--hairline); color: var(--text-muted); }
.quota p { margin: 8px 0 0; }
.quota-head { display: flex; justify-content: space-between; align-items: baseline; gap: 4px 12px; flex-wrap: wrap; }
.quota-countdown { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--amber); }
.quota.cleared .quota-countdown { color: var(--text-muted); }
.quota-note { color: var(--text-muted); font-size: 13px; }
.quota-raw { font-size: 11px; color: var(--text-faint); overflow-wrap: anywhere; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
code { font-family: var(--mono); }
</style>
