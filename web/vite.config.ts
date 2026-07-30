import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:8400",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8400",
        ws: true,
      },
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
    manifest: true,
    // Regression enforcement lives in check-bundle-budget.mjs and has separate
    // limits for initial code and opt-in renderers.
    chunkSizeWarningLimit: 1_000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("/livekit-client/") ||
            id.includes("/@livekit/components-react/")
          ) {
            return "vendor-livekit";
          }
          if (
            id.includes("/@xyflow/") ||
            id.includes("/@dagrejs/") ||
            /\/d3-[^/]+\//.test(id)
          ) {
            return "vendor-diagrams";
          }
          if (
            /\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(
              id,
            )
          ) {
            return "vendor-react";
          }
          if (
            id.includes("/framer-motion/") ||
            id.includes("/motion-dom/") ||
            id.includes("/motion-utils/")
          ) {
            return "vendor-motion";
          }
          if (
            id.includes("/@tanstack/react-query/") ||
            id.includes("/@tanstack/query-core/") ||
            id.includes("/zustand/")
          ) {
            return "vendor-data";
          }
          if (id.includes("/keycloak-js/")) return "vendor-auth";
          return undefined;
        },
      },
    },
  },
});
