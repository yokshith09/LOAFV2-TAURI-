import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects a fixed port and does not want vite to obscure Rust errors.
export default defineConfig({
  clearScreen: false,
  // See the note beside `minify`: names survive minification so an error report
  // names real functions instead of single letters.
  esbuild: { keepNames: true },
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
    // KEEP FUNCTION NAMES THROUGH MINIFICATION.
    //
    // Loaf reports an uncaught error to a file the user can send back, and in
    // a release build that stack was about to come back as `a@b:1:4823` —
    // mangled single letters, from a bundle with no source map. A diagnostic
    // that produces an unreadable answer is the failure this whole path has
    // hit three times already, one layer further down.
    //
    // `keepNames` costs a little size and nothing else: it does not disable
    // minification, it only stops function and class names being rewritten. A
    // stack that says `drawFrame` and `renderScene` is the difference between
    // a bug report and a shrug.
    rollupOptions: {
      // Six windows, six documents. Each is opened by Rust as its own
      // WebviewWindow, so each needs a real file at a URL the webview can be
      // pointed at — a client-side route would have nothing to point to.
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        bubble: resolve(__dirname, "bubble.html"),
        closet: resolve(__dirname, "closet.html"),
        focus: resolve(__dirname, "focus.html"),
        onboarding: resolve(__dirname, "onboarding.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
