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
    `http://127.0.0.1:${env.VITE_DEV_API_PORT?.trim() || "3003"}`;

  return {
    plugins: [react()],
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@shared": path.resolve(__dirname, "src/shared"),
        "@assets": path.resolve(__dirname, "../attached_assets"),
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
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: {
            // Vendor chunks (routing uses wouter, not react-router)
            "react-vendor": ["react", "react-dom"],
            "ui-vendor": [
              "@radix-ui/react-dialog",
              "@radix-ui/react-dropdown-menu",
              "@radix-ui/react-select",
              "@radix-ui/react-tooltip",
              "@radix-ui/react-toast",
            ],
            "chart-vendor": ["recharts"],
            "query-vendor": ["@tanstack/react-query"],
            "msal-vendor": ["@azure/msal-browser", "@azure/msal-react"],
            "utils-vendor": ["axios", "date-fns", "zod"],
            "grid-vendor": ["react-grid-layout", "react-resizable"],
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
