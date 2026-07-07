import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  SquareCode,
  Quote,
  type LucideIcon,
} from "lucide-react";

/**
 * Formatting actions the composer offers. Each maps to markdown the message
 * renderer (MessageBubble) actually parses — bold/italic/strike/inline-code,
 * fenced code blocks, and blockquotes. Deliberately NO markdown-link button:
 * the renderer only auto-links bare `https://…` URLs, not `[text](url)`
 * syntax, so a link wrap would render as literal brackets. No spoiler either.
 */
export type FormatKind =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeblock"
  | "blockquote";

interface FormatButton {
  kind: FormatKind;
  label: string;
  Icon: LucideIcon;
}

const BUTTONS: FormatButton[] = [
  { kind: "bold", label: "Bold (⌘B)", Icon: Bold },
  { kind: "italic", label: "Italic (⌘I)", Icon: Italic },
  { kind: "strike", label: "Strikethrough", Icon: Strikethrough },
  { kind: "code", label: "Inline code (⌘E)", Icon: Code },
  { kind: "codeblock", label: "Code block", Icon: SquareCode },
  { kind: "blockquote", label: "Blockquote", Icon: Quote },
];

interface FormatToolbarProps {
  /** Pixel position within the composer's textarea wrapper — the caret line of
   * the selection start. The bar floats just above this point. */
  position: { top: number; left: number };
  onFormat: (kind: FormatKind) => void;
}

/**
 * Discord/OpenWebUI-style selection formatting bar. Purely presentational —
 * MessageInput owns selection tracking and the wrap logic. Buttons
 * preventDefault on mousedown so a click never blurs the textarea or collapses
 * the selection (the wrap needs the live selection offsets). The fade-in
 * utility is disabled under prefers-reduced-motion in globals.css.
 */
export function FormatToolbar({ position, onFormat }: FormatToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Text formatting"
      style={{ top: position.top, left: position.left }}
      className="absolute z-20 -mt-1.5 flex -translate-y-full items-center gap-0.5 rounded-lg border border-line-strong bg-surface-2 p-1 shadow-pop animate-fade-in"
    >
      {BUTTONS.map(({ kind, label, Icon }) => (
        <button
          key={kind}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onFormat(kind)}
          aria-label={label}
          title={label}
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-stable-purple/20 hover:text-slate-100 focus-ring"
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
