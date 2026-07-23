import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  resolve: { dedupe: ["react", "react-dom"], tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({
      router: {
        quoteStyle: "double",
        semicolons: false,
      },
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
})

export default config
