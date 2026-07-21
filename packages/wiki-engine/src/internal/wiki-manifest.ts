import { Type } from "typebox"
import { Value } from "typebox/value"
import type { Static } from "typebox"

const wikiIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

export const WikiManifestSchema = Type.Object(
  {
    version: Type.Literal(2),
    id: Type.String({ pattern: wikiIdPatternSource }),
    domain: Type.String({ pattern: "^\\S(?:.*\\S)?$" }),
  },
  { additionalProperties: false }
)

export type WikiManifest = Static<typeof WikiManifestSchema>

const wikiIdPattern = new RegExp(wikiIdPatternSource)

export function validateWikiId(wikiId: string): string {
  if (!wikiIdPattern.test(wikiId)) {
    throw new Error("Invalid wiki ID")
  }
  return wikiId
}

export function isWikiId(value: unknown): value is string {
  return Value.Check(WikiManifestSchema.properties.id, value)
}

export function isWikiManifest(value: unknown): value is WikiManifest {
  return Value.Check(WikiManifestSchema, value)
}
