# 15 — Client — theming & a11y

Wave 4 (P-043) + Wave 5 (P-015, P-051, P-052, P-053).

---

### P-015 — Hardcoded theme colors in `InsightCard`

- **Severity:** high
- **Category:** theming (dark-mode breakage)
- **Location:** `client/src/pages/Home/Components/InsightCard.tsx:84`
- **Evidence:** `<span className="font-semibold text-gray-800 dark:text-gray-200">`. The file is not in `theme-check.mjs`'s tempDebt allowlist, so nothing catches this.
- **Fix:** Replace with `text-foreground`. Verify with `npm run theme:check`.
- **Status:** todo

### P-043 — `theme-check` not enforced in CI

- **Severity:** medium
- **Category:** CI gap
- **Location:** `.github/workflows/ci.yml`; `client/scripts/theme-check.mjs`
- **Evidence:** The script exists and runs locally but no CI job invokes it. PRs with theme violations merge silently.
- **Fix:** Add `run: npm run theme:check` to the client job in `ci.yml` after `npm ci`.
- **Status:** todo

### P-051 — Theme violations across multiple components

- **Severity:** medium
- **Category:** theming
- **Location:**
  - `client/src/components/UserEmailDebug.tsx:38, 39, 51, 55`
  - `client/src/components/AvailableModelsDialog.tsx:100-110`
  - `client/src/components/ColumnFilterDialog.tsx`
  - `client/src/components/FilterAppliedMessage.tsx`
  - `client/src/pages/Home/Components/DashboardModal/DashboardModal.tsx`
- **Evidence:** Hardcoded palette classes (`text-green-*`, `bg-blue-100`, `text-gray-500`, etc.). Several are listed in `theme-check.mjs`'s tempDebt allowlist as acknowledged-but-unfixed.
- **Fix:** Refactor to semantic tokens (`bg-primary/10 text-primary`, `surface-positive`, `surface-hover`, etc.). Remove each file from the tempDebt allowlist as it's cleaned.
- **Status:** todo

### P-052 — `theme-check.mjs` tempDebt allowlist is rotting

- **Severity:** medium
- **Category:** CI / theming
- **Location:** `client/scripts/theme-check.mjs`
- **Evidence:** Files marked "temp debt" remain in the allowlist long-term and nothing drives them out.
- **Fix:** After P-051's cleanups, remove each entry from the allowlist. Add a CI step that fails if the allowlist file hash hasn't changed in > N days while violations remain (optional).
- **Status:** todo

### P-053 — Missing aria labels / focus restoration

- **Severity:** medium
- **Category:** accessibility
- **Location:** `client/src/pages/Home/Components/` (ChatInterface, ThinkingPanel, ColumnSidebar, DataPreview), chart/filter dialogs
- **Evidence:** Explicit `aria-label`, `aria-describedby`, `aria-live` are missing on stop-generation buttons, thinking panels, live preview regions. Radix dialogs default focus restoration works only if callers don't mess with DOM.
- **Fix:** Audit with `axe-core` locally; add `aria-live="polite"` to the thinking panel, `aria-label="Stop generation"` on the stop button, `role="region" aria-label="Data preview"` on preview containers. Run through keyboard-only to confirm focus returns to the trigger after dialog close.
- **Status:** todo
