<script setup lang="ts">
const { fetch: refreshSession } = useUserSession()
const username = ref('')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = null
  try {
    await $fetch('/api/login', { method: 'POST', body: { username: username.value, password: password.value } })
    await refreshSession()
    await navigateTo('/')
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? 'Login failed'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="page login">
    <form class="card" @submit.prevent="submit">
      <h1 class="display logo">Crossfade</h1>
      <p class="muted">Spotify and Tidal, kept in step.</p>
      <div v-if="error" class="banner error" role="alert">{{ error }}</div>
      <label class="label" for="username">Username</label>
      <input id="username" v-model="username" type="text" autocomplete="username" required>
      <label class="label" for="password">Password</label>
      <input id="password" v-model="password" type="password" autocomplete="current-password" required>
      <button class="pill solid-mint" type="submit" :disabled="busy">{{ busy ? 'Signing in' : 'Sign in' }}</button>
    </form>
  </main>
</template>

<style scoped>
.login { display: grid; place-items: center; min-height: 100vh; }
form { width: min(400px, 100%); display: grid; gap: 10px; }
.logo { font-size: 30px; color: var(--mint); }
p { margin: 0 0 12px; }
label { margin-top: 6px; }
button { margin-top: 14px; }
</style>
