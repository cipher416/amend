import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Type } from "typebox"
import { Value } from "typebox/value"
import type { Static } from "typebox"

export interface WikiHomeState {
  readonly parentPath: string
  readonly wikiDirectory: string
  readonly lastActiveWikiId: string | null
}

const StoredWikiHomeSchema = Type.Object(
  {
    version: Type.Literal(1),
    parentPath: Type.String({ minLength: 1 }),
    lastActiveWikiId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
)

type StoredWikiHome = Static<typeof StoredWikiHomeSchema>

export class WikiHome {
  private readonly directoryPath: string
  private readonly homePath: string

  constructor({ userDataPath }: { userDataPath: string }) {
    this.directoryPath = join(userDataPath, "wikis")
    this.homePath = join(this.directoryPath, "home.json")
  }

  async read(): Promise<WikiHomeState | null> {
    let source: string
    try {
      source = await readFile(this.homePath, "utf8")
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
    const stored = parseStoredWikiHome(source)
    return stored ? toState(stored) : null
  }

  async setParentPath(parentPath: string): Promise<void> {
    await this.write({
      version: 1,
      parentPath,
      lastActiveWikiId: null,
    })
  }

  async setLastActiveWikiId(wikiId: string | null): Promise<void> {
    const home = await this.read()
    if (!home) throw new Error("Choose an Amend home first")
    await this.write({
      version: 1,
      parentPath: home.parentPath,
      lastActiveWikiId: wikiId,
    })
  }

  private async write(home: StoredWikiHome): Promise<void> {
    await mkdir(this.directoryPath, { recursive: true })
    const temporaryPath = join(
      this.directoryPath,
      `home.json.${process.pid}.${randomUUID()}.tmp`
    )
    let renamed = false
    try {
      await writeFile(temporaryPath, `${JSON.stringify(home, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      })
      await rename(temporaryPath, this.homePath)
      renamed = true
    } finally {
      if (!renamed)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

function parseStoredWikiHome(source: string): StoredWikiHome | null {
  try {
    const value: unknown = JSON.parse(source)
    return Value.Check(StoredWikiHomeSchema, value) ? value : null
  } catch {
    return null
  }
}

function toState(home: StoredWikiHome): WikiHomeState {
  return {
    parentPath: home.parentPath,
    wikiDirectory: home.parentPath,
    lastActiveWikiId: home.lastActiveWikiId,
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
