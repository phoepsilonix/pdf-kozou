import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome105", "safari13"],
    minify: "esbuild",
    sourcemap: !!process.env.TAURI_DEBUG,
    cssMinify: true,
    chunkSizeWarningLimit: 1000, // 警告閾値を少し緩和

    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20000,
          minShareCount: 2,

          groups: [
            // 1. React コア（最優先）
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|zustand)/,
              priority: 100,
            },

            // 2. その他すべての node_modules（vendor）
            {
              name: "vendor",
              test: /node_modules/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
