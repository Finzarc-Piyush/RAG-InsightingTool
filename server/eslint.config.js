// Flat ESLint config (ESM). Pragmatic, non-type-aware (fast) ruleset focused on
// real bugs. Lands report-only first; high-signal correctness rules are errors,
// stylistic/large-surface rules start as warnings to keep the gate adoptable.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "scripts/build-domain-packs.ts",
      // Wave R26 · Node tooling script (.mjs); the globals block below only
      // covers .ts/.tsx so its console/process would false-positive no-undef.
      "scripts/runTests.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // High-signal correctness — errors.
      "no-debugger": "error",
      "no-cond-assign": "error",
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unsafe-optional-chaining": "error",
      "eqeqeq": ["error", "smart"],
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/no-duplicate-enum-values": "error",
      // Large existing surface — warn for now (tightened in later waves).
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // CQ-8 · Size/complexity ratchet (warn, high thresholds) so the god-files
      // (runAgentTurn ~3378 LOC, parseDataOpsIntent ~2900 LOC) surface in lint
      // and can only shrink, never regrow. Decrement thresholds per decomposition
      // wave; graduate to error once the monsters are split.
      "max-lines-per-function": ["warn", { max: 400, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "complexity": ["warn", 50],
      "max-depth": ["warn", 6],
      // Noise in a large mature codebase — off.
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
);
