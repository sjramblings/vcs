const isTTY = process.stdout.isTTY === true;
const noColor = Bun.env.NO_COLOR !== undefined;
const forceColor = Bun.env.FORCE_COLOR !== undefined;
const useColor = (isTTY || forceColor) && !noColor;

const c = {
  green: (s: string) => useColor ? `\x1b[32m${s}\x1b[0m` : s,
  red: (s: string) => useColor ? `\x1b[31m${s}\x1b[0m` : s,
  dim: (s: string) => useColor ? `\x1b[2m${s}\x1b[0m` : s,
  bold: (s: string) => useColor ? `\x1b[1m${s}\x1b[0m` : s,
  yellow: (s: string) => useColor ? `\x1b[33m${s}\x1b[0m` : s,
};

export { c as colours };

export function result(data: unknown, isJson: boolean): void {
  if (isJson) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    process.stdout.write(formatHuman(data) + '\n');
  }
}

function formatHuman(data: unknown): string {
  if (data === null || data === undefined) return String(data);

  if (Array.isArray(data)) {
    if (data.length === 0) return '(empty)';
    // Array of objects: aligned columns
    if (typeof data[0] === 'object' && data[0] !== null) {
      const keys = Object.keys(data[0] as Record<string, unknown>);
      const widths = keys.map(k =>
        Math.max(k.length, ...data.map(row => String((row as Record<string, unknown>)[k] ?? '').length))
      );
      const header = keys.map((k, i) => k.padEnd(widths[i]!)).join('  ');
      const rows = data.map(row =>
        keys.map((k, i) => String((row as Record<string, unknown>)[k] ?? '').padEnd(widths[i]!)).join('  ')
      );
      return [header, ...rows].join('\n');
    }
    return data.map(String).join('\n');
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const entries = Object.entries(obj).filter(
      ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );
    if (entries.length === 0) return JSON.stringify(data, null, 2);
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
    return entries
      .map(([k, v]) => `${k.padStart(maxKeyLen)}  ${v}`)
      .join('\n');
  }

  return String(data);
}

export function status(message: string): void {
  process.stderr.write(`${c.dim(message)}\n`);
}

export function success(message: string): void {
  process.stderr.write(`${c.green('\u2713')} ${message}\n`);
}

export function error(message: string, hint?: string): void {
  process.stderr.write(`${c.red('\u2717')} ${message}\n`);
  if (hint) {
    process.stderr.write(`  ${c.dim(hint)}\n`);
  }
}

export function errorJson(code: string, message: string): void {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n');
}
