// Application shell: navigation, routing, and the per-tool frame.
//
// This file does NOT list tools — the registry discovers them from the
// filesystem. Adding a tool must never require editing here. See
// docs/PARALLEL.md.

import { Suspense } from 'react'
import { href, useRoute } from './lib/router'
import { categories, findTool, tools } from './tools/registry'

function Nav({ route }: { route: string }) {
  return (
    <nav>
      {categories.map((cat) => {
        const inCat = tools.filter((t) => t.category === cat && !t.draft)
        if (inCat.length === 0) return null
        return (
          <div key={cat} className="navgroup">
            <h3>{cat}</h3>
            <ul>
              {inCat.map((t) => (
                <li key={t.route}>
                  <a href={href(t.route)} aria-current={route === t.route ? 'page' : undefined}>
                    {t.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function Home() {
  return (
    <section>
      <h2>Pick a tool</h2>
      <p className="muted">
        {tools.filter((t) => !t.draft).length} available. Every operation runs in this tab — your
        files are never uploaded.
      </p>
      <ul className="cards">
        {tools
          .filter((t) => !t.draft)
          .map((t) => (
            <li key={t.route}>
              <a href={href(t.route)}>
                <strong>{t.name}</strong>
                <span className="muted">{t.description}</span>
              </a>
            </li>
          ))}
      </ul>
    </section>
  )
}

export function App() {
  const route = useRoute()
  const tool = route ? findTool(route) : undefined

  return (
    <div className="shell">
      <header>
        <a href="#/" className="brand">
          pdf-forge
        </a>
        <p className="muted">Go → WebAssembly engine, running entirely in this tab.</p>
      </header>

      <Nav route={route} />

      <main>
        {!route && <Home />}

        {route && !tool && (
          <section>
            <h2>Not found</h2>
            <p className="muted">
              No tool at <code>{route}</code>. <a href="#/">Back to all tools</a>.
            </p>
          </section>
        )}

        {tool && (
          <section>
            <h2>{tool.name}</h2>
            <p className="muted">{tool.description}</p>
            <Suspense fallback={<p className="muted">Loading…</p>}>
              <tool.Component />
            </Suspense>
          </section>
        )}
      </main>
    </div>
  )
}
