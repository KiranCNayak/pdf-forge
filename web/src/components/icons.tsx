// Small icon-only buttons (reorder, remove, duplicate, rotate) used to render
// plain Unicode glyphs (↑ ↓ ✕ ⧉ ↻), which render inconsistently across OS/
// font — different shapes, weights, and baseline alignment depending on the
// platform's emoji/symbol font. These are simple inline SVGs instead, matched
// to FilePicker's existing icon style (stroke=currentColor, strokeWidth=1.5,
// round caps/joins) so every icon in the app renders identically everywhere.
//
// Each button already carries its own aria-label — these icons are purely
// decorative and stay aria-hidden.

import type { SVGProps } from 'react'

const common: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
}

export function ArrowUpIcon() {
  return (
    <svg {...common}>
      <path d="M12 19V5m0 0-6 6m6-6 6 6" />
    </svg>
  )
}

export function ArrowDownIcon() {
  return (
    <svg {...common}>
      <path d="M12 5v14m0 0 6-6m-6 6-6-6" />
    </svg>
  )
}

export function XIcon() {
  return (
    <svg {...common}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

export function DuplicateIcon() {
  return (
    <svg {...common}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  )
}

export function RotateIcon() {
  return (
    <svg {...common}>
      <path d="M3 12a9 9 0 1 1 2.6 6.3" />
      <path d="M3 21v-6h6" />
    </svg>
  )
}
