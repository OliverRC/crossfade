// The Runs pages became Activity (old links and bookmarks still work).
export default defineEventHandler((event) => {
  const path = event.path
  if (path === '/runs' || path.startsWith('/runs/') || path.startsWith('/runs?')) return sendRedirect(event, path.replace(/^\/runs/, '/activity'), 301)
})
