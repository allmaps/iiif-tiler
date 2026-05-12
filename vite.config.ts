import tailwindcss from '@tailwindcss/vite'
import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin'
}

function setCrossOriginIsolationHeaders(response: ServerResponse) {
  for (const [header, value] of Object.entries(crossOriginIsolationHeaders)) {
    response.setHeader(header, value)
  }
}

function crossOriginIsolation(): Plugin {
  return {
    name: 'cross-origin-isolation',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(
        (
          _request: IncomingMessage,
          response: ServerResponse,
          next: () => void
        ) => {
          setCrossOriginIsolationHeaders(response)
          next()
        }
      )
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use((_request, response, next) => {
        setCrossOriginIsolationHeaders(response)
        next()
      })
    }
  }
}

export default defineConfig({
  plugins: [crossOriginIsolation(), tailwindcss(), sveltekit()],
  optimizeDeps: {
    exclude: ['wasm-vips']
  },
  server: {
    headers: crossOriginIsolationHeaders
  },
  preview: {
    headers: crossOriginIsolationHeaders
  }
})
