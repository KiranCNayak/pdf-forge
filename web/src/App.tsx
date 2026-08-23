import { MergeTool } from './tools/Merge/MergeTool'

export function App() {
  return (
    <main>
      <header>
        <h1>pdf-forge</h1>
        <p className="muted">
          Phase 0 skeleton — Go&nbsp;→&nbsp;WebAssembly engine, running entirely in this tab.
        </p>
      </header>
      <MergeTool />
    </main>
  )
}
