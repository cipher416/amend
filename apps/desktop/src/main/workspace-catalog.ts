import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface WorkspaceCatalogRecord {
  readonly id: string
  readonly path: string
}

export interface WorkspaceCatalogOptions {
  readonly userDataPath: string
  readonly rename?: typeof rename
}

interface CatalogData {
  version: 1
  lastActiveWorkspaceId: string | null
  workspaces: WorkspaceCatalogRecord[]
}

interface MutationResult<T> {
  changed: boolean
  value: T
}

const EMPTY_CATALOG: Readonly<CatalogData> = {
  version: 1,
  lastActiveWorkspaceId: null,
  workspaces: [],
}

export class WorkspaceCatalog {
  private readonly directoryPath: string
  private readonly catalogPath: string
  private readonly rename: typeof rename
  private pendingWrites: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceCatalogOptions) {
    this.directoryPath = join(options.userDataPath, "workspaces")
    this.catalogPath = join(this.directoryPath, "catalog.json")
    this.rename = options.rename ?? rename
  }

  async listWorkspaces(): Promise<readonly WorkspaceCatalogRecord[]> {
    await this.pendingWrites
    const catalog = await this.load()
    return catalog.workspaces.map(copyRecord)
  }

  async findLastActiveWorkspace(): Promise<WorkspaceCatalogRecord | null> {
    await this.pendingWrites
    const catalog = await this.load()
    const record = catalog.workspaces.find(
      ({ id }) => id === catalog.lastActiveWorkspaceId
    )
    return record ? copyRecord(record) : null
  }

  async upsertAndActivate(record: WorkspaceCatalogRecord): Promise<void> {
    assertRecord(record)
    await this.mutate((catalog) => {
      const index = catalog.workspaces.findIndex(({ id }) => id === record.id)
      if (index === -1) catalog.workspaces.push(copyRecord(record))
      else catalog.workspaces[index] = copyRecord(record)
      catalog.lastActiveWorkspaceId = record.id
      return { changed: true, value: undefined }
    })
  }

  async repairWorkspacePath(id: string, path: string): Promise<boolean> {
    assertNonblank(id, "Workspace ID")
    assertNonblank(path, "Workspace path")
    return await this.mutate((catalog) => {
      const record = catalog.workspaces.find((candidate) => candidate.id === id)
      if (!record) return { changed: false, value: false }
      if (record.path === path) return { changed: false, value: true }
      catalog.workspaces[catalog.workspaces.indexOf(record)] = { id, path }
      return { changed: true, value: true }
    })
  }

  async clearLastActive(): Promise<void> {
    await this.mutate((catalog) => {
      if (catalog.lastActiveWorkspaceId === null) {
        return { changed: false, value: undefined }
      }
      catalog.lastActiveWorkspaceId = null
      return { changed: true, value: undefined }
    })
  }

  async forgetWorkspace(id: string): Promise<boolean> {
    assertNonblank(id, "Workspace ID")
    return await this.mutate((catalog) => {
      const index = catalog.workspaces.findIndex((record) => record.id === id)
      if (index === -1) return { changed: false, value: false }
      catalog.workspaces.splice(index, 1)
      if (catalog.lastActiveWorkspaceId === id) {
        catalog.lastActiveWorkspaceId = null
      }
      return { changed: true, value: true }
    })
  }

  private async mutate<T>(
    change: (catalog: CatalogData) => MutationResult<T>
  ): Promise<T> {
    const operation = this.pendingWrites.then(async () => {
      const catalog = await this.load()
      const result = change(catalog)
      if (result.changed) await this.write(catalog)
      return result.value
    })
    this.pendingWrites = operation.then(
      () => undefined,
      () => undefined
    )
    return await operation
  }

  private async load(): Promise<CatalogData> {
    let source: string
    try {
      source = await readFile(this.catalogPath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyCatalog()
      throw error
    }

    try {
      return parseCatalog(JSON.parse(source)) ?? emptyCatalog()
    } catch (error) {
      if (error instanceof SyntaxError) return emptyCatalog()
      throw error
    }
  }

  private async write(catalog: CatalogData): Promise<void> {
    await mkdir(this.directoryPath, { recursive: true })
    const temporaryPath = join(
      this.directoryPath,
      `catalog.json.${process.pid}.${randomUUID()}.tmp`
    )
    let renamed = false
    try {
      await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      })
      await this.rename(temporaryPath, this.catalogPath)
      renamed = true
    } finally {
      if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

function parseCatalog(value: unknown): CatalogData | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (
    value.lastActiveWorkspaceId !== null &&
    !isNonblank(value.lastActiveWorkspaceId)
  ) {
    return null
  }
  if (!Array.isArray(value.workspaces)) return null

  const workspaces: WorkspaceCatalogRecord[] = []
  const ids = new Set<string>()
  for (const valueRecord of value.workspaces) {
    if (
      !isRecord(valueRecord) ||
      !isNonblank(valueRecord.id) ||
      !isNonblank(valueRecord.path) ||
      ids.has(valueRecord.id)
    ) {
      return null
    }
    ids.add(valueRecord.id)
    workspaces.push({ id: valueRecord.id, path: valueRecord.path })
  }

  return {
    version: 1,
    lastActiveWorkspaceId: value.lastActiveWorkspaceId,
    workspaces,
  }
}

function emptyCatalog(): CatalogData {
  return {
    version: EMPTY_CATALOG.version,
    lastActiveWorkspaceId: EMPTY_CATALOG.lastActiveWorkspaceId,
    workspaces: [],
  }
}

function copyRecord(record: WorkspaceCatalogRecord): WorkspaceCatalogRecord {
  return { id: record.id, path: record.path }
}

function assertRecord(record: WorkspaceCatalogRecord): void {
  assertNonblank(record.id, "Workspace ID")
  assertNonblank(record.path, "Workspace path")
}

function assertNonblank(value: string, label: string): void {
  if (!isNonblank(value)) throw new TypeError(`${label} must be a nonblank string.`)
}

function isNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}
