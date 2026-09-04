import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Pragmatic flat config. The hand-rolled InnerTube layer is intentionally
// typed as `Record<string, any>`, so the noisier type-safety rules are
// downgraded to warnings (or off) to keep `pnpm lint` green on the existing
// code — the point is a safety net going forward, not a wall of errors. Real
// correctness rules (rules-of-hooks) stay as errors.
export default tseslint.config(
  {
    ignores: [
      "dist",
      "src-tauri/target",
      "src/routeTree.gen.ts",
      "node_modules",
      "scripts",
      // Detached worktrees checked out by Claude Code: copies of the
      // same files, which would double every finding.
      ".claude",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      "no-constant-condition": ["warn", { checkLoops: false }],
      // Newer ESLint-10 recommended rules that flag pre-existing style in
      // this codebase — kept as warnings so `pnpm lint` is a green baseline
      // (tighten to error and clean up incrementally).
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
    },
  },
);
