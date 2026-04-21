# 16 — Client — build & bundle hygiene

Wave 3 + Wave 5.

---

### P-038 — `@assets → ../attached_assets` alias points at nonexistent directory

- **Severity:** medium
- **Category:** build config (dead alias)
- **Location:** `client/vite.config.ts` (alias section)
- **Evidence:** `"@assets": path.resolve(__dirname, "../attached_assets")` — `/home/user/RAG-InsightingTool/attached_assets/` does not exist.
- **Fix:** Grep for `@assets/` imports; if zero, remove the alias. Otherwise create the directory with a `README.md` placeholder so devs can populate it.
- **Status:** todo

### P-063 — `postcss.config.js` not re-audited for Tailwind v4 assumptions (suspicion)

- **Severity:** low
- **Category:** build
- **Location:** `client/postcss.config.js`
- **Evidence:** Tailwind v4 integrates PostCSS differently from v3; the existing config may carry redundant plugins.
- **Fix:** Read the file, compare with Tailwind v4 docs, prune unused plugins. Confirm `npm run build` still works.
- **Status:** todo

### P-064 — `manualChunks` doesn't isolate heavy Recharts sub-modules

- **Severity:** low
- **Category:** bundle size
- **Location:** `client/vite.config.ts:44-58`
- **Evidence:** `"chart-vendor": ["recharts"]` bundles all chart types into one chunk even though most pages use a subset.
- **Fix:** Profile actual usage; if pie/radar/sankey are rarely used, split them into lazy-loaded chunks. Otherwise leave as-is (Rollup tree-shakes unused exports already).
- **Status:** todo

### P-071 — `main.tsx` uses non-null assertion on root element

- **Severity:** low
- **Category:** hygiene
- **Location:** `client/src/main.tsx:6`
- **Evidence:** `createRoot(document.getElementById("root")!)` — silent failure if `index.html` ever loses the `#root` element.
- **Fix:** `const root = document.getElementById("root"); if (!root) throw new Error("Missing #root in index.html"); createRoot(root).render(...);`
- **Status:** todo

### P-073 — Debug `console.*` calls leak to production

- **Severity:** low
- **Category:** logging
- **Location:**
  - `client/src/auth/msalConfig.ts:11-13`
  - `client/src/contexts/AuthContext.tsx:37-43`
  - `client/src/utils/envCheck.ts:16-20`
  - `client/src/pages/Home/Components/DashboardModal/DashboardModal.tsx`
  - `client/src/pages/Home/Components/DataSummaryModal.tsx`
  - `client/src/pages/Home/Components/DatasetEnrichmentLoader.tsx`
- **Evidence:** Raw `console.log` / `console.error` instead of `logger.ts`. Some leak user email / tenant-id prefixes.
- **Fix:** Route through `logger.ts`. Gate verbose calls behind `import.meta.env.DEV`. Do one sweeping PR across the listed files.
- **Status:** todo

### P-077 — `vite.config.ts` manually loads non-standard `client.env`

- **Severity:** low
- **Category:** decision flag
- **Location:** `client/vite.config.ts:9`
- **Evidence:** `loadClientEnv({ path: "client.env", quiet: true })`. Non-standard filename; contributors expect `.env.local`.
- **Fix:** Decision: (a) rename to `.env.local` and remove the manual load (Vite handles it natively); or (b) keep `client.env` but document the reason prominently in `README.md`. Recommendation: (a) after P-002 templatization.
- **Status:** todo
