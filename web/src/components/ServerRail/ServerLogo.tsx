import clsx from "clsx";
import { useFederationStore } from "@/stores/federationStore";
import { identityFor } from "@/lib/identity";
import { displayName } from "@/lib/instances";
import type { StableInstance } from "@/services/instances";

/**
 * A server's rail avatar.
 *
 * Precedence: admin-uploaded logo (fetched into a blob: URL by federationStore
 * — see @/lib/instances for why we never render a peer-supplied URL) → the
 * static `icon` from instances.json when it is a short glyph → the generated
 * initial on the server's identity colour.
 *
 * NOTE the deliberate absence: a `startsWith("http")` icon from instances.json
 * is NOT rendered as a remote <img> any more. That path let whoever wrote the
 * mounted file (or, once federated, a peer) point every viewer's browser at an
 * arbitrary host. Runtime logos go through the vetted fetch instead.
 */
export function ServerLogo({
  instance,
  size,
  active = false,
  className,
}: {
  instance: StableInstance;
  size: "sm" | "md" | "lg";
  active?: boolean;
  className?: string;
}) {
  const meta = useFederationStore((state) => state.metaByInstance[instance.id]);
  const logo = useFederationStore((state) => state.logoByInstance[instance.id]);

  const ident = identityFor(instance.id, displayName(instance, meta));
  const accent = meta?.accent ?? ident.color;
  // A one- or two-character glyph is safe to render as text; anything longer
  // (a URL, a sentence) is not an icon and falls through to the initial.
  const glyph = instance.icon && instance.icon.length <= 2 ? instance.icon : null;
  const initial = displayName(instance, meta).slice(0, 1).toUpperCase();

  const box = size === "sm" ? "h-8 w-8 text-xs" : size === "md" ? "h-10 w-10 text-sm" : "h-12 w-12 text-sm";

  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-2xl font-semibold transition-all",
        box,
        active && "rounded-xl",
        className,
      )}
      style={
        logo
          ? active
            ? { boxShadow: `0 0 0 2px ${accent}` }
            : undefined
          : {
              background: active ? accent : ident.soft,
              color: active ? "#ffffff" : ident.text,
            }
      }
      aria-hidden="true"
    >
      {logo ? (
        <img src={logo} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        glyph ?? initial
      )}
    </span>
  );
}
