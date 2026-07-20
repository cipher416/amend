import { defineConfig } from "vite"

export default defineConfig({
  build: {
    target: "node22",
    outDir: ".vite/preload",
    emptyOutDir: true,
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    rolldownOptions: {
      external: ["electron", /^node:/, "pdf-parse"],
      output: {
        entryFileNames: "preload.js",
        chunkFileNames: "[name].js",
        format: "cjs",
        codeSplitting: false,
      },
    },
  },
})
