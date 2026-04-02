import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    legacy({
      // 互換性が必要なブラウザをここに集約
      targets: ["defaults", "chrome 105", "safari 13", "not IE 11"],
      modernPolyfills: true,
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: [ "es2021" ],
    minify: "esbuild",
    sourcemap: !!process.env.TAURI_DEBUG,
    cssMinify: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === "PLUGIN_TIMINGS") return;
        warn(warning);
      },
    },
  },
});
