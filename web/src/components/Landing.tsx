import { useEffect } from "react";

/**
 * The marketing front door, shown by LandingGate to brand-new anonymous
 * visitors. The page itself is a self-contained static asset served from
 * /stable-landing.html (public/), rendered in a full-viewport same-origin
 * iframe so its editorial CSS/JS can never collide with the app's styles.
 * Its "Enter Stable" CTAs postMessage `stable:enter` up to this component,
 * which asks LandingGate to mount AuthGate (→ the normal Keycloak login).
 */
export function Landing({ onEnter }: { onEnter: () => void }) {
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data === "stable:enter") onEnter();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEnter]);

  return (
    <iframe
      src="/stable-landing.html"
      title="Unicorn Stable"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: "none" }}
    />
  );
}
