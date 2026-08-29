import { defineConfig } from "vite";

// Tauri expects a fixed port and does not want vite to obscure Rust errors.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri is Rust; vite has no business watching it.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri targets a known webview per platform, so we can target modern output.
  // Windows ships WebView2 (Chromium); macOS ships WKWebView (Safari).
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
