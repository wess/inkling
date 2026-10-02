import { useEffect, useRef } from "react"
import { inlineHtml } from "./html.ts"
import "./style.css"

const commands = [
  ["Italic", "italic"],
  ["Line break", "insertLineBreak"],
  ["Undo", "undo"],
  ["Redo", "redo"],
] as const

export const FormattedInput = ({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) => {
  const editor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = editor.current
    if (!node || node === document.activeElement) return
    node.innerHTML = inlineHtml(new DOMParser().parseFromString(value, "text/html").body)
  }, [value])

  const sync = () => {
    if (editor.current) onChange(inlineHtml(editor.current))
  }
  const command = (name: string) => {
    if (disabled) return
    editor.current?.focus()
    document.execCommand(name)
    sync()
  }

  return (
    <div className="formattedinput">
      <div className="richtools" role="toolbar" aria-label={`${label} formatting`}>
        {commands.map(([text, action]) => (
          <button
            key={action}
            type="button"
            className="btn ghost sm"
            disabled={disabled}
            onMouseDown={event => event.preventDefault()}
            onClick={() => command(action)}
          >
            {text}
          </button>
        ))}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot edit formatted text */}
      <div
        id={id}
        ref={editor}
        className="formattedcontent"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-multiline="true"
        aria-disabled={disabled}
        onInput={sync}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault()
            command("insertLineBreak")
          }
        }}
        onPaste={event => {
          event.preventDefault()
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"))
          sync()
        }}
      />
      <span className="dim2">Select words to make them italic. Press Enter for a new line.</span>
    </div>
  )
}
