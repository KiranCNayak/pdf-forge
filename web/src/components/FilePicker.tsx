// Shared drag-and-drop file picker for every tool page. Replaces the bare
// `<input type="file">` each tool used to render inline — same signature
// (`onFiles(FileList | null)`), so swapping it in changed no tool's logic.
//
// The visible drop zone is decorative; the real <input type="file"> underneath
// stays interactive and keyboard-reachable (tab to it, Enter/Space opens the
// native picker, screen readers see a normal file input with a real label).
// Drag-and-drop is progressive enhancement on top of that, not a replacement
// for it — see docs/tools/*.md's a11y notes and the `dragging-alternative`
// rule from the ui-ux-pro-max skill.

import { useId, useRef, useState, type DragEvent } from 'react'

interface Props {
  onFiles: (files: FileList | null) => void
  multiple?: boolean
  accept?: string
  /** Shown as the primary line in the drop zone. Defaults to a generic PDF prompt. */
  label?: string
  hint?: string
}

export function FilePicker({
  onFiles,
  multiple = false,
  accept = 'application/pdf',
  label,
  hint,
}: Props) {
  const [dragOver, setDragOver] = useState(false)
  const inputId = useId()

  // The drop zone has child elements (icon, label text, hidden input) inside this
  // <label>, so `dragleave` fires every time the pointer crosses into or out of a
  // child, not just when it truly leaves the zone. A plain boolean flickers off
  // mid-drag. Count enters/leaves instead — only clear at zero. See docs/STATE.md
  // backlog for the repro that caught this.
  const dragDepth = useRef(0)

  function onDragEnter(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }

  function onDragLeave(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragOver(false)
    }
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    onFiles(e.dataTransfer.files)
  }

  return (
    <label
      htmlFor={inputId}
      className={`file-picker${dragOver ? ' file-picker--drag' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <svg
        className="file-picker__icon"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 15V3m0 0-4 4m4-4 4 4" />
        <path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
      </svg>
      <span className="file-picker__label">
        {label ?? (multiple ? 'Drop PDFs here, or click to browse' : 'Drop a PDF here, or click to browse')}
      </span>
      {hint && <span className="file-picker__hint">{hint}</span>}
      <input
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => onFiles(e.target.files)}
      />
    </label>
  )
}
