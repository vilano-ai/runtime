export function writeOutput<T>(
  flags: Record<string, string | boolean>,
  body: T,
  renderHuman?: (body: T) => string
): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  if (renderHuman) {
    process.stdout.write(`${renderHuman(body)}\n`);
    return;
  }

  process.stdout.write(`${String(body)}\n`);
}
