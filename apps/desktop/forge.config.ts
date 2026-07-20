import { access } from "node:fs/promises"
import path from "node:path"

import { FuseV1Options, FuseVersion } from "@electron/fuses"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { VitePlugin } from "@electron-forge/plugin-vite"
import type { ForgeConfig } from "@electron-forge/shared-types"

const rendererDirectory = path.resolve(__dirname, "../web/dist/client")
const wikiSkillDirectory = path.resolve(
  __dirname,
  "../../packages/wiki-engine/skills/llm-wiki"
)

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "amend",
    extraResource: [rendererDirectory, wikiSkillDirectory],
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux", "win32"],
      config: {},
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    generateAssets: async () => {
      await Promise.all([
        access(path.join(rendererDirectory, "_shell.html")),
        access(path.join(wikiSkillDirectory, "SKILL.md")),
      ])
    },
  },
}

export default config
