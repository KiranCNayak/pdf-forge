// Sanitizes a user-typed output filename before it's handed to downloadBytes.
// Called once, at the point of download — not on every keystroke, so the user
// can type freely and only sees the cleaned-up value take effect on click.
export function sanitizeFilename(input: string, fallback: string): string {
  const name = input
    .trim()
    .replace(/[\\/]/g, '-') // path separators
    .replace(/[\x00-\x1f<>:"|?*]/g, '') // control chars + Windows-invalid chars
    .trim()

  if (!name) return fallback
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}
