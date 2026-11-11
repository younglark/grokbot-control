/**
 * `npm pack --json` writes a JSON array to stdout. A package `prepack`
 * script may print tsc/vite logs (including ANSI color) before that array.
 * Parse the trailing JSON value rather than the entire stdout.
 */
export function lastJsonValue(text) {
  if (typeof text !== 'string') {
    throw new TypeError('npm pack stdout must be a string');
  }
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through and locate a JSON array that starts at a line boundary.
  }
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf('\n[', searchFrom);
    if (start < 0) break;
    const candidate = text.slice(start + 1).trimEnd();
    try {
      return JSON.parse(candidate);
    } catch {
      searchFrom = start + 2;
    }
  }
  throw new SyntaxError('unable to locate trailing npm pack JSON array');
}
