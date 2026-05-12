import { defineConfig } from "vite";

const SERVER_PORT = Number(process.env["BIBLIARY_SERVER_PORT"] ?? "3000");

/**
 * Vite dev server для веб-renderer'а. Запускается через `npm run dev:web`
 * параллельно с `npm run dev:server` (концентрация в `npm run dev`).
 *
 * Root указывает на `renderer/`, чтобы Vite видел `index.html` как entry.
 * /api/* проксируется на Hono backend, чтобы fetch'ам из renderer'а не
 * пришлось бы знать про CORS и сложить cookies из другого origin.
 */
export default defineConfig({
  root: "renderer",
  publicDir: "vendor",
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: false,
        secure: false,
      },
    },
  },
  build: {
    outDir: "../dist-renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
});
