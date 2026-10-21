import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
// Vitest's config helper, so the `test` block below is typed. It extends
// Vite's own configuration, so this file still builds the app unchanged.
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'

const SNAPSHOT_PATH = resolve(import.meta.dirname, '../snapshot.json')
const SNAPSHOT_ROUTE = '/snapshot.json'

/**
 * Serves the repository-root `snapshot.json` to the frontend.
 *
 * The snapshot is committed at the repo root (it is the backend's output, not
 * a frontend asset), so rather than duplicating it into `public/` this plugin
 * serves it from disk in dev and emits it into `dist/` at build time. One file,
 * one source of truth.
 */
function snapshotPlugin(): Plugin {
  return {
    name: 'portfolio-snapshot',
    configureServer(server) {
      server.middlewares.use(SNAPSHOT_ROUTE, (_request, response) => {
        try {
          response.setHeader('Content-Type', 'application/json')
          response.end(readFileSync(SNAPSHOT_PATH, 'utf-8'))
        } catch {
          response.statusCode = 404
          response.end(
            JSON.stringify({
              error: 'snapshot.json not found - run backend/generate_snapshot.py',
            }),
          )
        }
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'snapshot.json',
        source: readFileSync(SNAPSHOT_PATH, 'utf-8'),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), snapshotPlugin()],
  build: {
    target: 'es2022',
    // ECharts and Lightweight Charts are large; splitting them keeps the app
    // chunk small enough to parse quickly on first paint.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/echarts')) return 'echarts'
          if (id.includes('node_modules/lightweight-charts')) return 'lightweight-charts'
          return undefined
        },
      },
    },
  },
  test: {
    // The unit tests cover the pure logic: formatters, the hash router and
    // the snapshot normaliser. They need a DOM only for the router's
    // window access, which jsdom provides.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    reporters: 'default',
  },
})
