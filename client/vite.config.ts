import path from "path";
import { fileURLToPath } from "url";
import { config as loadClientEnv } from "dotenv";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Non-standard filename: Vite only auto-loads `.env*`. Prime process.env so loadEnv picks up VITE_*.
loadClientEnv({ path: path.join(__dirname, "client.env"), quiet: true });

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname), "");
  const devApiTarget =
    env.VITE_DEV_API_ORIGIN?.trim() ||
    `http://127.0.0.1:${env.VITE_DEV_API_PORT?.trim() || "3002"}`;

  return {
    plugins: [react()],
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@shared": path.resolve(__dirname, "src/shared"),
        // P-038: @assets alias pointed at ../attached_assets which does not
        // exist and had zero imports; removed.
      },
    },
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: devApiTarget,
          changeOrigin: true,
        },
      },
      // W5 · `client/src/shared/schema.ts` re-exports from
      // `../../../server/shared/schema.ts` so the schema lives in one file.
      // Vite's default fs.allow is the project root; widen it to the repo root
      // so the dev server can resolve the cross-package import.
      fs: {
        allow: [path.resolve(__dirname, "..")],
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // PERF-9: split heavy, independently-cacheable vendor groups into
          // their own chunks so the catch-all vendor chunk stops dwarfing
          // everything. Function form (keyed on the resolved module id) is
          // robust to sub-package paths — every `@radix-ui/*`, `@tanstack/*`,
          // `@visx/*`, `@azure/msal*` entry point is captured, not just the
          // few we happen to list. Only packages present in package.json are
          // referenced. Order matters: first match wins. Non-node_modules
          // ids fall through to Rollup's default app chunking (don't break
          // route-level code-splitting).
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;

            // React core (routing uses wouter, not react-router).
            if (
              id.includes("node_modules/react/") ||
              id.includes("node_modules/react-dom/") ||
              id.includes("node_modules/scheduler/")
            ) {
              return "react-vendor";
            }

            // echarts is huge (~1 MB) and its own world (ships zrender).
            // Keep it isolated so it doesn't bloat the other chart chunks.
            if (
              id.includes("node_modules/echarts/") ||
              id.includes("node_modules/zrender/")
            ) {
              return "echarts";
            }

            // Charting stack: visx + the d3 primitives it pulls in, plus
            // recharts. These are large and change rarely.
            if (
              id.includes("node_modules/@visx/") ||
              id.includes("node_modules/d3-") ||
              id.includes("node_modules/recharts/") ||
              id.includes("node_modules/victory-vendor/")
            ) {
              return "charts";
            }

            // All Radix UI primitives.
            if (id.includes("node_modules/@radix-ui/")) {
              return "radix";
            }

            // TanStack (react-query + react-virtual).
            if (id.includes("node_modules/@tanstack/")) {
              return "tanstack";
            }

            // Azure MSAL auth stack.
            if (id.includes("node_modules/@azure/msal")) {
              return "msal";
            }

            // Spreadsheet / file export libs.
            if (
              id.includes("node_modules/exceljs/") ||
              id.includes("node_modules/papaparse/")
            ) {
              return "sheets";
            }

            // Animation runtime.
            if (id.includes("node_modules/framer-motion/")) {
              return "motion";
            }

            // Grid / resizable layout.
            if (
              id.includes("node_modules/react-grid-layout/") ||
              id.includes("node_modules/react-resizable/")
            ) {
              return "grid-vendor";
            }

            // Small shared utils.
            if (
              id.includes("node_modules/axios/") ||
              id.includes("node_modules/date-fns/") ||
              id.includes("node_modules/zod/")
            ) {
              return "utils-vendor";
            }

            return undefined;
          },
        },
      },
      // Enable source maps for better debugging in production (optional)
      sourcemap: false,
      // Optimize chunk splitting
      chunkSizeWarningLimit: 1000,
    },
    // Optimize dependencies
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "@tanstack/react-query",
        "recharts",
        "@azure/msal-browser",
        "@azure/msal-react",
      ],
    },
  };
});
