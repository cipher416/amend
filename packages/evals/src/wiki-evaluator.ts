export interface WikiJudgeResult {
  score: number
  criteria: {
    sourceFidelity: number
    crossSourceSynthesis: number
    organization: number
    navigability: number
  }
  strengths: string[]
  issues: string[]
}

export function parseWikiJudgeResult(output: string): WikiJudgeResult {
  const json = extractJson(output)
  const value = JSON.parse(json) as unknown
  if (!isRecord(value)) throw new Error("Wiki judge did not return an object")
  if (
    !isScore(value.score) ||
    !isRecord(value.criteria) ||
    !isScore(value.criteria.sourceFidelity) ||
    !isScore(value.criteria.crossSourceSynthesis) ||
    !isScore(value.criteria.organization) ||
    !isScore(value.criteria.navigability) ||
    !isStringArray(value.strengths) ||
    !isStringArray(value.issues)
  ) {
    throw new Error("Wiki judge result does not match the eval schema")
  }
  return value as unknown as WikiJudgeResult
}

function extractJson(output: string): string {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) return fenced.trim()
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end < start)
    throw new Error("Wiki judge returned no JSON")
  return output.slice(start, end + 1)
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 100
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
