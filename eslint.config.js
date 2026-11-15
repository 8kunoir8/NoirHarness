import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import noir from "./tools/eslint-plugin-noir/index.js";

const IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "build/**",
  "release/**",
  "release-next/**",
  "test-results/**",
  "playwright-report/**",
  ".noir/**",
  ".superpowers/**",
];

/** The renderer's own directory: nothing outside it may be imported from this code. */
const RENDERER_ROOT = "apps/desktop/src/renderer";

export default tseslint.config(
  { ignores: IGNORES },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // TypeScript already answers this one, and answers it with types.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // A promise that is neither awaited nor returned is a race the compiler cannot see. `void` is
      // how this codebase says "deliberately not awaited".
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // A binding a closure may read before its single assignment cannot be a `const`: the two
      // `let` handles here exist exactly so an early call site sees `undefined`, not a TDZ throw.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // Test doubles speak untyped JSON on purpose: the reply shape a test asserts is the point, and
    // typing every wire reply would make the fixture the schema. Product code keeps the ban.
    files: ["**/test/**/*.ts", "**/test/**/*.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // The renderer runs in its own process with its own globals and its own import boundary.
    files: [`${RENDERER_ROOT}/**/*.ts`, `${RENDERER_ROOT}/**/*.tsx`],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { noir, "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "noir/no-cross-process-import": ["error", { rendererRoot: RENDERER_ROOT }],
      "noir/no-bare-timer": ["error", { allow: [`${RENDERER_ROOT}/defer.ts`] }],
    },
  },
  {
    files: ["apps/desktop/test/**/*.spec.ts"],
    plugins: { noir },
    rules: { "noir/strict-locator-name": "error" },
  },
);
