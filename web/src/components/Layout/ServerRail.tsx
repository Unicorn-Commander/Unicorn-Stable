/**
 * The ServerRail moved to `@/components/ServerRail/` when it grew logos, a hide
 * toggle, search and descriptions — it is four files now, not one. This shim
 * keeps AppShell's existing `./ServerRail` import working unchanged.
 */
export { ServerRail } from "@/components/ServerRail";
