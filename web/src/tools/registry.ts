// Tool registry — discovers tools from the filesystem.
//
// Each tool lives in web/src/tools/<Name>/ and provides exactly two files:
//
//   meta.ts    export const meta: ToolMeta = { ... }   (eager, tiny)
//   tool.tsx   export default function ...             (lazy, the real component)
//
// Nothing central lists them. Adding a tool means creating a directory and
// nothing else — no edit to this file, no edit to App.tsx, no shared file
// touched at all. That is what lets several tools be built in parallel without
// every branch conflicting on the same three lines. See docs/PARALLEL.md.
//
// meta is eager so navigation can render without loading every tool's code;
// tool.tsx is lazy so each tool stays its own chunk.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

export interface ToolMeta {
  /** URL path, without the leading '#/'. Must be unique. */
  route: string
  /** Shown in navigation. */
  name: string
  /** One line, shown under the heading. */
  description: string
  /** Grouping in the navigation, mirroring docs/TOOL_CATALOG.md. */
  category: 'Organize' | 'Convert' | 'Security' | 'Share'
  /** Hidden from navigation while under construction. */
  draft?: boolean
}

export interface Tool extends ToolMeta {
  Component: LazyExoticComponent<ComponentType>
}

const metaModules = import.meta.glob<{ meta: ToolMeta }>('./*/meta.ts', { eager: true })
const toolModules = import.meta.glob<{ default: ComponentType }>('./*/tool.tsx')

function dirOf(path: string): string {
  return path.split('/')[1]
}

export const tools: Tool[] = Object.entries(metaModules)
  .map(([path, mod]) => {
    const dir = dirOf(path)
    const loader = toolModules[`./${dir}/tool.tsx`]
    if (!loader) {
      throw new Error(`tool "${dir}" has meta.ts but no tool.tsx`)
    }
    return { ...mod.meta, Component: lazy(loader) }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

// A duplicate route means two tools silently shadow each other. Fail at startup
// rather than at whichever one the router happens to match second.
const seen = new Set<string>()
for (const t of tools) {
  if (seen.has(t.route)) throw new Error(`duplicate tool route: ${t.route}`)
  seen.add(t.route)
}

export const categories: ToolMeta['category'][] = ['Organize', 'Convert', 'Security', 'Share']

export function findTool(route: string): Tool | undefined {
  return tools.find((t) => t.route === route)
}
