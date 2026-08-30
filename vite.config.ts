import { defineConfig } from "vite";
import { resolve } from "node:path";

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
    rollupOptions: {
      // Five windows, five documents. Each is opened by Rust as its own
      // WebviewWindow, so each needs a real file at a URL the webview can be
      // pointed at — a client-side route would have nothing to point to.
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        bubble: resolve(__dirname, "bubble.html"),
        closet: resolve(__dirname, "closet.html"),
        focus: resolve(__dirname, "focus.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
