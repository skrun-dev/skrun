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

/**
 * A conversation turn handed to an adapter other than the one that produced
 * it. A programming error: a turn only goes back to the provider that wrote it,
 * and the router never passes one across providers. The message names both
 * providers, never the turn's content — that is the model's own output.
 */
export class LLMHistoryError extends Error {
  readonly code = "LLM_HISTORY_FOREIGN_TURN";
  constructor(
    public readonly expectedProvider: string,
    public readonly receivedProvider: string,
  ) {
    super(
      `A conversation turn from provider '${receivedProvider}' was passed to the '${expectedProvider}' adapter; a turn only goes back to the provider that produced it.`,
    );
    this.name = "LLMHistoryError";
  }
}
