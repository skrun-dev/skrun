// PDF text extraction tool (demo)
// In production, this would use a PDF library like pdf-parse
// For the demo, it processes the input text and returns structured output

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const args = JSON.parse(input);
    const content = args.content || args.args || "";
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const pages = Math.max(1, Math.ceil(text.length / 3000));

    console.log(
      JSON.stringify({
        extracted_text: text,
        pages: pages,
        characters: text.length,
        status: "success",
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        error: err.message,
        status: "failed",
      }),
    );
  }
});
