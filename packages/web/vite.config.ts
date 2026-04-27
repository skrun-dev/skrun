import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/dashboard/",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/auth": "http://localhost:4000",
      "/health": "http://localhost:4000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
