import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    fs: { strict: false },
    headers: {
      // The engine is served from public/ as a plain asset. No COOP/COEP here:
      // cross-origin isolation would buy us SharedArrayBuffer, but we do not use
      // it (see docs/LLD.md §1.6) and enabling it complicates asset loading.
    },
  },
  build: { target: 'es2022' },
})
