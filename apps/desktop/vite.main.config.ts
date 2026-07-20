import { defineConfig } from "vite"

export default defineConfig({
  ssr: {
    external: ["electron", "pdf-parse"],
    noExternal: true,
  },
  build: {
    ssr: "src/main/index.ts",
    target: "node22",
    outDir: ".vite/main",
    emptyOutDir: true,
    lib: {
      entry: "src/main/index.ts",
      formats: ["es"],
      fileName: () => "main.mjs",
    },
    rollupOptions: {
      external: ["electron", "pdf-parse"],
      output: {
        entryFileNames: "main.mjs",
        chunkFileNames: "[name]-[hash].mjs",
        format: "es",
      },
    },
  },
})
