// Preserve numeric tokens before JSON.parse can round quantities or long IDs.
// Quoted JSON strings are copied verbatim, including escaped quotes.
export function parseLosslessJson(text: string): unknown {
  let output = "", index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") { index += 2; continue; }
        if (text[index++] === '"') break;
      }
      output += text.slice(start, index);
    } else if (ch === "-" || /\d/.test(ch)) {
      const token = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!token) throw new Error("无效 JSON 数值");
      output += '"' + token[0] + '"';
      index += token[0].length;
    } else { output += ch; index++; }
  }
  return JSON.parse(output);
}
