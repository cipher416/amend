import { fileURLToPath, URL } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      react: fileURLToPath(
        new URL("../../node_modules/react", import.meta.url)
      ),
      "react-dom": fileURLToPath(
        new URL("../../node_modules/react-dom", import.meta.url)
      ),
    },
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    server: {
      deps: { inline: [/@base-ui/] },
    },
  },
})
