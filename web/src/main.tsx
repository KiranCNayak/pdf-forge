import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { engine } from './engine/EngineClient'
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
