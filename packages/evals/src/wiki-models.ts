export function resolveWikiEvalModels(
  settings: { provider: string; model: string },
  environment: Readonly<Record<string, string | undefined>> = process.env
): { provider: string; model: string; judgeModel: string } {
  const provider = environment.AMEND_PI_PROVIDER ?? settings.provider
  const modelOverride = environment.AMEND_PI_MODEL
  const judgeModelOverride = environment.AMEND_PI_JUDGE_MODEL

  if (
    provider !== settings.provider &&
    (!modelOverride || !judgeModelOverride)
  ) {
    throw new Error(
      "AMEND_PI_MODEL and AMEND_PI_JUDGE_MODEL are required when overriding AMEND_PI_PROVIDER"
    )
  }

  return {
    provider,
    model:
      modelOverride ??
      (provider === "openai-codex" ? "gpt-5.6-luna" : settings.model),
    judgeModel: judgeModelOverride ?? settings.model,
  }
}
