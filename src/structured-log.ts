export function formatStructuredLog(
  record: Record<string, unknown>,
  now: Date = new Date(),
): string {
  return `${JSON.stringify({ ...record, ts: now.toISOString() })}\n`;
}

export function writeStructuredLog(record: Record<string, unknown>): void {
  process.stderr.write(formatStructuredLog(record));
}
