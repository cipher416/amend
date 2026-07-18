import { defineConfig } from "vite"

export default defineConfig({
  build: {
    target: "node22",
    outDir: ".vite/build",
    emptyOutDir: false,
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    rollupOptions: {
      external: ["electron", /^node:/],
    },
  },
})
