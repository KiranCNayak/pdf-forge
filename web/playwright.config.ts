import { defineConfig, devices } from '@playwright/test'

// End-to-end tests drive the real app in a real browser — the layer nothing
// else in the repo covers. Go tests prove the engine ops; the browser smoke
// test (web/src/dev/smoke.ts) proves the Go↔JS bridge; these prove the UI
// wiring on top of both: file pickers, staged lists, reorder buttons, option
// forms, downloads. See docs/STATE.md "Testing" for how the three layers
// divide up.
//
// Runs against a real Vite dev server serving the already-built Wasm engine
// (web/public/wasm/, staged by scripts/build-wasm.sh — run that first if
// engine.wasm is missing or stale).

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // p2p-share.spec.ts needs a live signaling server — VITE_SIGNALING_URL
      // defaults to this exact address (web/.env.example). `go run` recompiles
      // on every start, which the 30s timeout below allows for.
      command: 'go run ./cmd/signaling',
      cwd: '../signaling',
      port: 8080,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
})
