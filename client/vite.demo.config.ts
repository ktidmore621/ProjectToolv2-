import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Standalone demo build: bundles the whole app (fonts included) into one
 * self-contained HTML file with the in-browser backend, so it can be opened
 * by double-clicking — no server, no install.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  define: { "import.meta.env.VITE_DEMO": '"1"' },
  build: {
    outDir: "dist-demo",
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 5_000,
  },
});
