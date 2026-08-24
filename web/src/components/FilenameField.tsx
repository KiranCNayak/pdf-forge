// Output-filename input shown next to a tool's Download button. Sanitizing
// happens in lib/filename.ts at download time, not here — this component just
// holds the raw, unsanitized value so the user can type freely.

interface Props {
  value: string
  onChange: (value: string) => void
}

export function FilenameField({ value, onChange }: Props) {
  return (
    <label>
      File name
      <br />
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
