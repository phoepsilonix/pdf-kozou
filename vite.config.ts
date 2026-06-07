// vite.config.ts
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
    chunkSizeWarningLimit: 400, // 警告閾値を下げる

    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 10000,
          minShareCount: 1,

          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|zustand|scheduler)/,
              priority: 100,
            },
            {
              name: "vendor",
              test: /node_modules/,
              priority: 50,
            },
          ],
        },
      },
    },
  },
});
