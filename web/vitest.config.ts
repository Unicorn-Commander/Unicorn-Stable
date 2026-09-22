import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Vitest stops reading vite.config.ts once this file exists, so merge it.
 * The app alias, React plugin, and Tailwind plugin stay the ones the unit
 * suite already ran under. jsdom is the environment; Avatar's DOM tests opt
 * into it, and the setup file no-ops its browser stubs when window is absent.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      globals: true,
    },
  }),
);
