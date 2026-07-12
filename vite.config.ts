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
    // TS側と合わせてES2024以降をターゲットに
    target: ["es2024"],
    sourcemap: !!process.env.TAURI_DEBUG,

    // Oxc(またはRolldown内蔵高速ミニファイア)による圧縮を明示
    //minify: "oxc",
    minify: true,
    cssMinify: true,
    chunkSizeWarningLimit: 500,

    // Vite 8/Rolldown環境のコード分割設定
    rolldownOptions: {
      output: {
        // manualChunks または最新の規格に合わせたコードスプリッティング
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("react") ||
              id.includes("react-dom") ||
              id.includes("zustand") ||
              id.includes("scheduler")
            ) {
              return "react";
            }
            return "vendor";
          }
        },
      },
    },
  },
});
