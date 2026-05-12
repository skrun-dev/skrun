export class LLMCapabilityError extends Error {
  readonly code = "LLM_CAPABILITY_UNSUPPORTED";
  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly mediaKind: "image" | "document" | "audio",
  ) {
    super(
      `Model '${provider}/${model}' does not support '${mediaKind}' inputs. Update model + fallback in agent.yaml or change input type.`,
    );
    this.name = "LLMCapabilityError";
  }
}
