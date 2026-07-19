import { describe, expect, it } from "vitest"

import { resolveWikiEvalModels } from "./wiki-models.ts"

describe("wiki eval models", () => {
  const settings = {
    provider: "anthropic",
    model: "claude-test",
  }

  it("requires explicit models when overriding the configured provider", () => {
    expect(() =>
      resolveWikiEvalModels(settings, {
        AMEND_PI_PROVIDER: "openai-codex",
      })
    ).toThrow(
      "AMEND_PI_MODEL and AMEND_PI_JUDGE_MODEL are required when overriding AMEND_PI_PROVIDER"
    )
  })

  it("uses explicit models with an overridden provider", () => {
    expect(
      resolveWikiEvalModels(settings, {
        AMEND_PI_PROVIDER: "openai-codex",
        AMEND_PI_MODEL: "gpt-agent",
        AMEND_PI_JUDGE_MODEL: "gpt-judge",
      })
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-agent",
      judgeModel: "gpt-judge",
    })
  })
})
