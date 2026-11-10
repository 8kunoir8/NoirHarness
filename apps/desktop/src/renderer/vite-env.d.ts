/// <reference types="vite/client" />

// The Monaco ESM entry ships without declarations; its runtime surface is the
// package's public editor API (`monaco-editor`'s `editor.api.d.ts`).
// Verified against monaco-editor 0.52.2.
declare module "monaco-editor/esm/vs/editor/editor.main.js" {
  export * from "monaco-editor";
}
