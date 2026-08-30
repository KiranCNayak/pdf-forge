import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { engine } from './engine/EngineClient'
// Self-hosted, bundled by Vite — no runtime CDN fetch, per CLAUDE.md's hard
// constraint. Only the weights actually used (see styles.css) are imported,
// and the latin-only subset specifically — every other tool page's copy is
// English, and the un-scoped per-weight CSS pulls in @font-face blocks for
// cyrillic/greek/vietnamese/etc. subsets this app never needs.
import '@fontsource/geist-sans/latin-400.css'
import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-600.css'
import '@fontsource/geist-sans/latin-700.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import './styles.css'

// Dev-only handles so the engine can be driven from the console or an automated
// browser test without going through the UI. Stripped from production builds.
// Run `await __smoke()` to exercise the whole bridge.
if (import.meta.env.DEV) {
  const g = globalThis as unknown as { __engine: typeof engine; __smoke: () => Promise<string> }
  g.__engine = engine
  g.__smoke = async () => (await import('./dev/smoke')).smoke()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
