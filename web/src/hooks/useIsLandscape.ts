import { useState, useEffect } from "react";
const LANDSCAPE_QUERY = "(orientation: landscape)";
export function useIsLandscape(): boolean {
  const [landscape, setLandscape] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia(LANDSCAPE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(LANDSCAPE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setLandscape(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return landscape;
}
