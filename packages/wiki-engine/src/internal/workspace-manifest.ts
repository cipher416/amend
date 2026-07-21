import { Type } from "typebox"
import { Value } from "typebox/value"
import type { Static } from "typebox"

const workspaceIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

export const WorkspaceManifestSchema = Type.Object(
  {
    version: Type.Literal(2),
    id: Type.String({ pattern: workspaceIdPatternSource }),
    domain: Type.String({ pattern: "^\\S(?:.*\\S)?$" }),
  },
  { additionalProperties: false }
)

export type WorkspaceManifest = Static<typeof WorkspaceManifestSchema>

const workspaceIdPattern = new RegExp(workspaceIdPatternSource)

export function validateWorkspaceId(workspaceId: string): string {
  if (!workspaceIdPattern.test(workspaceId)) {
    throw new Error("Invalid wiki workspace ID")
  }
  return workspaceId
}

export function isWorkspaceId(value: unknown): value is string {
  return Value.Check(WorkspaceManifestSchema.properties.id, value)
}

export function isWorkspaceManifest(
  value: unknown
): value is WorkspaceManifest {
  return Value.Check(WorkspaceManifestSchema, value)
}
