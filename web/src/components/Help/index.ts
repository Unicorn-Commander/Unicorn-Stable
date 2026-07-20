/**
 * The help surface.
 *
 * `HelpCenter` fills its container — embed it in a pane (Settings does).
 * `HelpModal` is the same thing with its own dialog chrome, for opening Help
 * on its own from the app shell.
 *
 * The content it renders lives in `@/content/help` as markdown files. Nothing
 * in this directory needs to change to add, edit or remove a guide.
 */
export { HelpCenter, default as HelpCenterDefault } from "./HelpCenter";
export type { HelpCenterProps } from "./HelpCenter";
export { HelpModal } from "./HelpModal";
export type { HelpModalProps } from "./HelpModal";
export { HelpAgentPanel } from "./HelpAgentPanel";
export { HelpMarkdown } from "./HelpMarkdown";
