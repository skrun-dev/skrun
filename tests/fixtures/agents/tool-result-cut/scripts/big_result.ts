// E2E test fixture: writes about 1.5 MiB of plain text, more than a tool's
// result is cut to, so the runtime cuts it before the model reads it. Plain
// words keep the model's input well within its window once cut.
const SENTENCE = "The quick brown fox jumps over the lazy dog. ";
const BYTES = 1.5 * 1024 * 1024;
process.stdout.write(SENTENCE.repeat(Math.ceil(BYTES / SENTENCE.length)));
