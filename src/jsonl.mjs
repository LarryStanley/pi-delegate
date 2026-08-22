// 嚴格 LF 分隔。**不可**改用 node:readline —— 它也會在 U+2028 / U+2029
// 處斷行，會把 JSON payload 內含這些字元的行切壞，而且是靜默的。
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
