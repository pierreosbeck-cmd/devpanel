import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build to web/dist (served by the Hono API). During `vite dev`, proxy /api to
// the running API on 8899 so the front end talks to the real backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8899", changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
