// Parses a typed page-selection string like "1-3, 5, 8-12" into a sorted,
// deduplicated list of page numbers, validated against the document's page
// count.
//
// The Go-backed tools (Rotate, ExtractPages) hand this same syntax straight
// to pdfcpu's own parser (api.ParsePageSelection) and never touch it in JS.
// Render-worker tools have no engine to hand it to, so this is the JS-side
// counterpart — deliberately a subset (no `even`/`odd`/`!exclusion`, see
// docs/tools/extract-pages.md) since nothing here needs the fuller syntax yet.
export function parsePageSelection(input: string, pageCount: number): number[] {
  const pages = new Set<number>()

  for (const raw of input.split(',')) {
    const part = raw.trim()
    if (!part) continue

    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new Error(`"${part}" isn't a valid page or range`)

    const start = Number(m[1])
    const end = m[2] ? Number(m[2]) : start
    if (start < 1 || end > pageCount) throw new Error(`"${part}" is outside 1–${pageCount}`)
    if (start > end) throw new Error(`"${part}" has a start after its end`)

    for (let p = start; p <= end; p++) pages.add(p)
  }

  return [...pages].sort((a, b) => a - b)
}
