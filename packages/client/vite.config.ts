import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs, so the same build works at the site root locally
  // and under /city-council/ on GitHub Pages.
  base: "./",
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
