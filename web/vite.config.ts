import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Local dev: the API runs separately on :8080. In the Render
    // deploy the server serves web/dist itself, so no proxy involved.
    proxy: { "/api": "http://localhost:8080" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
