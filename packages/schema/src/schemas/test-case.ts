import { z } from "zod";

/** What a test's `input` must be: an object of input values. */
const TestInputValues = z.record(z.string(), z.unknown());

/**
 * A test's `input`, judged as an object of input values and returned as it was
 * given. `z.record` alone would return a copy built key by key, by assignment:
 * a key named `__proto__` — any non-empty name is an input's name — would set
 * the copy's prototype instead of being one of its keys, and leave the input.
 * The record schema still judges it, so an input that is not an object is
 * refused in the same words.
 */
const TestInputSchema = z.custom<Record<string, unknown>>().superRefine((value, ctx) => {
  const judged = TestInputValues.safeParse(value);
  if (!judged.success) {
    for (const issue of judged.error.issues) ctx.addIssue({ ...issue });
  }
});

export const TestCaseSchema = z.object({
  name: z.string().min(1, "Test name is required"),
  input: TestInputSchema,
  assert: z.string().min(1, "Test assertion expression is required"),
});

export type TestCase = z.infer<typeof TestCaseSchema>;
