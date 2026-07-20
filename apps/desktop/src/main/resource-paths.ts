import path from "node:path"

export function resolveWikiSkillPath(options: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, "llm-wiki", "SKILL.md")
    : path.resolve(
        options.appPath,
        "../../packages/wiki-engine/skills/llm-wiki/SKILL.md"
      )
}
