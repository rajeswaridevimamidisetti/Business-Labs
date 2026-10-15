import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/task1": { target: "http://127.0.0.1:8001", rewrite: (path) => path.replace(/^\/api\/task1/, "") },
      "/api/task2": { target: "http://127.0.0.1:8002", rewrite: (path) => path.replace(/^\/api\/task2/, "") },
      "/api/task3": { target: "http://127.0.0.1:8003", rewrite: (path) => path.replace(/^\/api\/task3/, "") }
    }
  }
});
