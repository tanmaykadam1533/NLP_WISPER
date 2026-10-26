import { defineConfig } from "vite";

const api = process.env.API_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
});
