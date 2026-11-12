import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Relative base so assets resolve under the ephemeral /s/<session>/ prefix.
export default defineConfig({
  root,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
  build: {
    outDir: path.resolve(root, "../dist/dashboard"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
  },
});
