import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Outputs to <repo>/public/discovery/. The Express server already statically
// serves /public, so the bundle is reachable at /discovery once built.
// During `npm run dev`, the proxy below forwards /api requests to the live
// Express server on :3001 so the directory table works without mocking.
export default defineConfig({
  base: "/discovery/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../../public/discovery"),
    emptyOutDir: false,
    sourcemap: false,
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Stable filenames so committed build output doesn't churn hashes
        // every build. Cache-busting comes from content + Express static
        // headers, not hashed filenames.
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5174,
  },
});
