# Extract Text

**Route** `/extract-text` · **Phase** 2 · **Engine** JS (pdf.js)

## Purpose

Pull all text out of a PDF as plain text, preserving paragraph structure as far as the
document allows.

**Goes to JS, not Go**, despite pdfcpu having `api.ExtractContent`. pdf.js reconstructs
text _layout_ — it gives each glyph run a transform matrix, which is what you need to
infer line breaks, paragraphs, columns and reading order. pdfcpu's extraction is
lower-level and would mean rebuilding that inference ourselves for a worse result.

This is the boundary rule earning its keep in the less obvious direction: Go is not
automatically the right answer.

## User flow

1. Pick a file.
2. Optional page selection.
3. Extract → preview in a scrollable pane → copy all, or download `.txt`.

## Implementation

```ts
const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const content = await page.getTextContent();
  // content.items: { str, transform, width, height, fontName, hasEOL }
}
```

Naively joining `items.map(x => x.str)` with spaces — which is what ihatepdf does — loses
every line and paragraph break. Do better:

- Group items into lines by comparing `transform[5]` (the y translation) within a
  tolerance derived from font size.
- Sort each line's items by `transform[4]` (x).
- Insert a paragraph break when the vertical gap between lines meaningfully exceeds the
  prevailing line height.
- Use `hasEOL` where pdf.js provides it.
- Detect multi-column layouts by clustering x-positions; without this, two-column academic
  papers extract as interleaved nonsense.

Column detection is the difference between a tool people use and a tool people try once.

## Memory

Light — text only, no canvases. The concern is the output string on very large documents:
a 1000-page book can produce several MB of text, and JS strings are UTF-16, so budget
roughly 2× the character count in bytes.

Stream results per page into the preview rather than building one giant string, and
virtualise the preview pane.

## Edge cases

| Case                                      | Behaviour                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scanned PDF (images, no text layer)       | Extracts nothing. **Detect this and say so** — "this looks like a scan; text extraction needs OCR, which we don't offer yet". Returning an empty box is the worst outcome |
| Two-column layout                         | Column detection, per above                                                                                                                                               |
| Ligatures (ﬁ, ﬂ)                          | Normalise to ASCII equivalents optionally; some users want fidelity, most want searchable text                                                                            |
| Non-Latin scripts                         | pdf.js handles them; ensure the preview font does too                                                                                                                     |
| RTL text (Arabic, Hebrew)                 | Logical vs visual order differs. Note as a known limitation rather than silently mangling                                                                                 |
| Encrypted input                           | Prompt for password                                                                                                                                                       |
| Custom font encoding with no `/ToUnicode` | Extraction yields garbage glyph codes. Detect a high proportion of unmapped characters and warn                                                                           |
| Text inside form fields                   | `getTextContent` misses them; read the annotation layer separately if we want them                                                                                        |

The scanned-PDF and no-`/ToUnicode` cases together account for most real-world "this tool
is broken" reports. Both are detectable. Detect them.

## UI states

Idle → loaded → extracting (per-page progress) → done (virtualised preview, character
count, copy / download `.txt`) → empty-result (scan detected, explained) → error.

## Fixtures

`text_only.pdf`, `two_column_paper.pdf`, `scanned_no_text_layer.pdf`, `arabic.pdf`,
`cjk.pdf`, `no_tounicode.pdf`, `form_with_values.pdf`, `encrypted_aes256.pdf`.
