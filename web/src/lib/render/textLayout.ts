// Text-layout reconstruction from pdf.js text items.
//
// pdf.js hands back a flat list of glyph runs, each with a transform matrix
// and no notion of lines, paragraphs or columns. Naively joining
// `items.map(x => x.str)` with spaces — what ihatepdf does — loses every
// line and paragraph break. See docs/tools/extract-text.md.
//
// This is heuristic, not exact: PDF has no semantic structure to recover
// this from, only glyph positions. The thresholds below are tuned to behave
// well on ordinary prose and simple two-column layouts, not guaranteed
// correct on every layout ever produced.

export interface TextItemLike {
  str: string
  transform: number[] // [a, b, c, d, e, f] — e = x, f = y, in PDF user space (y grows upward)
  width: number
  height: number
  hasEOL?: boolean
}

interface Line {
  y: number
  fontSize: number
  items: TextItemLike[]
}

const REPLACEMENT_CHAR = '�'

/** Groups raw text items into lines by comparing their y translation within a font-size-derived tolerance. */
function groupLines(items: TextItemLike[]): Line[] {
  const lines: Line[] = []

  for (const item of items) {
    if (!item.str) continue
    const y = item.transform[5]
    // transform[3] is the glyph's vertical scale; hypot(b,d) is more robust
    // for rotated text but falls back cleanly for the common upright case.
    const fontSize = Math.hypot(item.transform[1], item.transform[3]) || Math.abs(item.transform[3]) || 10
    const tolerance = Math.max(fontSize * 0.35, 1)

    let line = lines.find((l) => Math.abs(l.y - y) <= tolerance)
    if (!line) {
      line = { y, fontSize, items: [] }
      lines.push(line)
    }
    line.items.push(item)
  }

  // PDF user space is bottom-up; reading order is top-to-bottom.
  lines.sort((a, b) => b.y - a.y)
  for (const line of lines) {
    line.items.sort((a, b) => a.transform[4] - b.transform[4])
  }
  return lines
}

/**
 * Clusters lines into columns by the x-position of their first glyph, so a
 * two-column layout doesn't interleave left/right text line-by-line.
 * Returns column-major groups of lines, each still in top-to-bottom order.
 */
function detectColumns(lines: Line[]): Line[][] {
  if (lines.length < 4) return [lines]

  const starts = lines.map((l) => l.items[0]?.transform[4] ?? 0).sort((a, b) => a - b)
  const pageSpan = starts[starts.length - 1] - starts[0]
  if (pageSpan < 50) return [lines]

  // A gap between consecutive left-edges meaningfully larger than the
  // median gap reads as a column boundary rather than ordinary word/indent
  // variation.
  const gaps = starts.slice(1).map((s, i) => s - starts[i])
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0
  const boundaryThreshold = Math.max(medianGap * 4, 40)

  const clusterStarts: number[] = [starts[0]]
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] > boundaryThreshold) clusterStarts.push(starts[i + 1])
  }
  if (clusterStarts.length < 2) return [lines]

  const columns: Line[][] = clusterStarts.map(() => [])
  for (const line of lines) {
    const x = line.items[0]?.transform[4] ?? 0
    let idx = 0
    for (let i = 0; i < clusterStarts.length; i++) {
      if (x >= clusterStarts[i] - boundaryThreshold / 2) idx = i
    }
    columns[idx].push(line)
  }
  return columns.filter((c) => c.length > 0)
}

export interface PageTextResult {
  text: string
  /** Raw item count before filtering — 0 across a whole document signals a scanned PDF. */
  itemCount: number
  charCount: number
  replacementCharCount: number
}

/** Reconstructs one page's text with line, paragraph and column structure from pdf.js text items. */
export function reconstructPageText(items: TextItemLike[]): PageTextResult {
  const lines = groupLines(items)
  const columns = detectColumns(lines)

  const paragraphs: string[] = []
  let charCount = 0
  let replacementCharCount = 0

  for (const column of columns) {
    let prevY: number | null = null
    let prevHeight = 0
    let current: string[] = []

    const flush = () => {
      if (current.length) paragraphs.push(current.join(' '))
      current = []
    }

    for (const line of column) {
      const lineText = line.items
        .map((it) => it.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!lineText) continue

      charCount += lineText.length
      for (const ch of lineText) if (ch === REPLACEMENT_CHAR) replacementCharCount++

      if (prevY !== null && prevHeight > 0) {
        const gap = prevY - line.y
        // A vertical gap noticeably larger than the previous line's height
        // reads as a paragraph break rather than ordinary line leading.
        if (gap > prevHeight * 1.6) flush()
      }
      current.push(lineText)
      prevY = line.y
      prevHeight = line.fontSize
    }
    flush()
  }

  return {
    text: paragraphs.join('\n\n'),
    itemCount: items.length,
    charCount,
    replacementCharCount,
  }
}
