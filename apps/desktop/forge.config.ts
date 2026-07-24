import { access, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

import { FuseV1Options, FuseVersion } from "@electron/fuses"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { VitePlugin } from "@electron-forge/plugin-vite"
import type { ForgeConfig } from "@electron-forge/shared-types"

const rendererDirectory = path.resolve(__dirname, "../web/dist/client")
const require = createRequire(__filename)
const dugiteDirectory = path.dirname(require.resolve("dugite/package.json"))
const gitDirectory = path.join(dugiteDirectory, "git")
const licensesDirectory = path.resolve(__dirname, "licenses")
const thirdPartyNotices = path.resolve(__dirname, "THIRD-PARTY-NOTICES.md")
const wikiSkillDirectory = path.resolve(
  __dirname,
  "../../packages/wiki-engine/skills/llm-wiki"
)

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "amend",
    extraResource: [
      rendererDirectory,
      wikiSkillDirectory,
      gitDirectory,
      licensesDirectory,
      thirdPartyNotices,
    ],
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
        access(gitDirectory),
        access(path.join(licensesDirectory, "DUGITE-LICENSE.txt")),
        access(path.join(licensesDirectory, "GIT-GPL-2.0.txt")),
        access(path.join(rendererDirectory, "_shell.html")),
        access(thirdPartyNotices),
        access(path.join(wikiSkillDirectory, "SKILL.md")),
      ])
      await verifyBundledGitNotice()
    },
  },
}

async function verifyBundledGitNotice(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(
      path.join(dugiteDirectory, "script", "embedded-git.json"),
      "utf8"
    )
  ) as Record<string, { url: string }>
  const releaseTags = new Set(
    Object.values(manifest).map(({ url }) => {
      const match = /\/download\/([^/]+)\//.exec(url)
      if (!match) throw new Error(`Invalid Dugite Native release URL: ${url}`)
      return match[1]
    })
  )
  if (releaseTags.size !== 1) {
    throw new Error("Dugite platforms do not use one native Git release")
  }

  const [releaseTag] = releaseTags
  const notices = await readFile(thirdPartyNotices, "utf8")
  if (!releaseTag || !notices.includes(`\`${releaseTag}\``)) {
    throw new Error("Third-party notices do not name the Dugite Native release")
  }
}

export default config
