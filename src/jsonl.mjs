// Strict LF splitting. Do NOT switch to node:readline — it also breaks lines on
// U+2028 / U+2029, which corrupts any line whose JSON payload contains those
// characters, and it does so silently.
export function createJsonlSplitter() {
  let buffer = "";

  return function push(chunk) {
    buffer += chunk;
    const lines = [];
    let index;

    while ((index = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }

    return lines;
  };
}
