import { defineConfig } from "vite"

export default defineConfig({
  build: {
    target: "node22",
    outDir: ".vite/build",
    emptyOutDir: false,
    lib: {
      entry: "src/main/index.ts",
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: ["electron", /^node:/],
    },
  },
})
