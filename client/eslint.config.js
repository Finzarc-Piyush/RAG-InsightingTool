// Flat ESLint config (ESM). Pragmatic, non-type-aware (fast) ruleset for the
// React 18 + TS SPA. Report-only first; high-signal correctness rules are
// errors, large-surface stylistic rules start as warnings to keep it adoptable.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "**/*.config.{js,ts}", "scripts/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Wave R31 · all conditional-hook violations fixed (hooks hoisted above
      // early returns, made null-safe) — rules-of-hooks is now ENFORCED as an
      // error (inherited from the recommended preset; the temporary "warn"
      // override is removed).
      // High-signal correctness — errors.
      "no-debugger": "error",
      "no-cond-assign": "error",
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unsafe-optional-chaining": "error",
      "eqeqeq": ["error", "smart"],
      "@typescript-eslint/no-misused-new": "error",
      // FE-3 · exhaustive-deps is an ERROR (all violations fixed behaviour-
      // preservingly; intentional omissions carry a justified disable comment).
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // CQ-8 / FE-2 · Size/complexity ratchet (warn, high thresholds) so god
      // components (DataPreviewTable ~3633 LOC) surface in lint and can only
      // shrink. Decrement per decomposition wave.
      "max-lines-per-function": ["warn", { max: 400, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "complexity": ["warn", 50],
      "max-depth": ["warn", 6],
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
);
