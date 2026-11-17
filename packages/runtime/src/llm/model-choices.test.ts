import { getModelCapabilities, MODEL_CHOICES } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import { pricingFor } from "./cost.js";
import { getMaxOutputTokens } from "./model-tables.js";

// The models `skrun init` offers are the ones a new agent runs on first: each
// must be known to the three tables a run reads — what it accepts, what it
// costs, how much it may write.
describe("the model choices offered to an agent author", () => {
  it.each(
    MODEL_CHOICES.map((c) => [`${c.provider}/${c.name}`, c] as const),
  )("%s resolves in the capability matrix, has a pricing row and an output limit", (_id, choice) => {
    expect(getModelCapabilities(choice.provider, choice.name)).toBeDefined();
    expect(pricingFor(choice.name).key).toBeDefined();
    expect(getMaxOutputTokens(choice.name)).toBeGreaterThan(0);
  });
});
