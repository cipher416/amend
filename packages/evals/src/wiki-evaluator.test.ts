import { describe, expect, it } from "vitest"

import { parseWikiJudgeResult } from "./wiki-evaluator.ts"

describe("wiki eval judge", () => {
  it("parses a fenced JSON quality result", () => {
    expect(
      parseWikiJudgeResult(`Result:
\`\`\`json
{
  "score": 84,
  "criteria": {
    "sourceFidelity": 90,
    "crossSourceSynthesis": 80,
    "organization": 85,
    "navigability": 81
  },
  "strengths": ["Connects both papers"],
  "issues": ["One page is long"]
}
\`\`\``)
    ).toEqual({
      score: 84,
      criteria: {
        sourceFidelity: 90,
        crossSourceSynthesis: 80,
        organization: 85,
        navigability: 81,
      },
      strengths: ["Connects both papers"],
      issues: ["One page is long"],
    })
  })
})
