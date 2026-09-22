import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Browser stubs for component tests. Node-environment tests (the rest of the
// suite) never see `window`; guard so this file can stay on the tsc include
// list without crashing them if the environment is narrowed later.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // jsdom does not lay out. The Avatar suite asserts that a size / ring /
  // radius was applied; a stable computed style is what those assertions read.
  const mockComputedStyle = {
    width: "32px",
    height: "32px",
    borderRadius: "9999px",
    boxShadow: "0 0 0 2px #8b5cf6",
    background: "linear-gradient(135deg, #1e1b2e 0%, #2d1b4e 100%)",
    fontSize: "13px",
    getPropertyValue: vi.fn((prop: string) => {
      const value = mockComputedStyle[prop as keyof typeof mockComputedStyle];
      return typeof value === "string" ? value : "";
    }),
  };

  Object.defineProperty(window, "getComputedStyle", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      ...mockComputedStyle,
      get width() {
        return "32px";
      },
      get height() {
        return "32px";
      },
    })),
  });
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => null,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
