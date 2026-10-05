import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function offlineAppShell(): Plugin {
  return {
    name: 'vista-offline-app-shell',
    apply: 'build',
    generateBundle(_, bundle) {
      const assets = Object.keys(bundle).filter((fileName) => fileName !== 'sw.js')
      const urls = [...new Set([
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/icons/vista.svg',
        ...assets.map((fileName) => `/${fileName}`),
      ])]
      const revisionHash = createHash('sha256')
      assets.sort().forEach((fileName) => {
        const output = bundle[fileName]
        revisionHash.update(fileName)
        revisionHash.update(output.type === 'chunk' ? output.code : output.source)
      })
      const revision = revisionHash.digest('hex').slice(0, 12)
      const source = `const CACHE_NAME = 'vista-app-${revision}'
const APP_SHELL = ${JSON.stringify(urls)}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('vista-app-') && key !== CACHE_NAME).map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cached = await caches.match('/index.html')
      return cached || Response.error()
    }))
    return
  }
  event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response.ok) return response
    return cache.put(request, response.clone()).then(() => response)
  }))))
})
`
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

export default defineConfig({
  plugins: [react(), offlineAppShell()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
  build: {
    chunkSizeWarningLimit: 550,
  },
})
