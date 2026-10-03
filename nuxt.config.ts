export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  modules: ['nuxt-auth-utils'],
  // Spotify rejects "localhost" redirect URIs, so dev serves on the loopback IP; localhost:4050 is redirected there.
  devServer: { host: '127.0.0.1', port: 4050 },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'Crossfade',
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Orbitron:wght@900&family=Space+Grotesk:wght@400;500;600;700&display=swap' },
      ],
    },
  },
  typescript: { strict: true },
})
