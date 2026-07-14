const HOST_SEPARATOR = "::";
const PENDING_PREFIX = "pending:";

export function createPendingCodexThreadId(hostId: string, sessionId: string): string {
  const pendingId = `${PENDING_PREFIX}${sessionId}`;
  return hostId === "legacy" ? pendingId : `${hostId}${HOST_SEPARATOR}${pendingId}`;
}

export function isPendingCodexThreadId(threadId: string): boolean {
  const separator = threadId.indexOf(HOST_SEPARATOR);
  const rawThreadId = separator > 0 ? threadId.slice(separator + HOST_SEPARATOR.length) : threadId;
  return rawThreadId.startsWith(PENDING_PREFIX);
}
