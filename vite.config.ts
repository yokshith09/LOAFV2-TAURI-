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
      // Two windows, two documents. The dashboard has to be a real entry point
      // rather than a route: it is opened by Rust as its own WebviewWindow, so
      // it needs a file at a URL the webview can be pointed at.
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
