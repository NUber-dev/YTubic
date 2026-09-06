import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Release-cover build. Copied to the project root by
// .claude/skills/release-cover/render.py for one build and removed after.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  base: "./",
  build: {
    outDir: process.env.COVER_OUT ?? "cover-dist",
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, "cover.html") },
  },
});
