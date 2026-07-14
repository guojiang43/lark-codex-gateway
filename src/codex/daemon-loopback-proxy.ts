import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net, { type AddressInfo, type Socket } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 48_123;

export interface DaemonLoopbackProxyOptions {
  socketPath?: string;
  host?: string;
  port?: number;
  pathToken: string;
}

export interface DaemonLoopbackProxy {
  address: AddressInfo;
  close(): Promise<void>;
}

export async function startDaemonLoopbackProxy(
  options: DaemonLoopbackProxyOptions,
): Promise<DaemonLoopbackProxy> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error("Codex daemon proxy must bind to the IPv4 loopback address");
  }
  const socketPath = options.socketPath
    ?? join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
  if (!options.pathToken) {
    throw new Error("Codex daemon proxy requires a non-empty path token");
  }
  const expectedPath = Buffer.from(`/${options.pathToken}`);
  const clients = new Set<Socket>();
  const server = net.createServer((client) => {
    clients.add(client);
    client.setTimeout(5_000, () => client.destroy());
    let buffered = Buffer.alloc(0);
    const reject = () => {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      clients.delete(client);
    };
    const consumeHandshake = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffered.length > 8_192) reject();
        return;
      }
      client.off("data", consumeHandshake);
      const requestLineEnd = buffered.indexOf("\r\n");
      const match = buffered.subarray(0, requestLineEnd).toString("ascii").match(/^GET ([^ ]+) HTTP\/1\.[01]$/);
      const actualPath = Buffer.from(match?.[1] ?? "");
      if (actualPath.length !== expectedPath.length || !timingSafeEqual(actualPath, expectedPath)) {
        reject();
        return;
      }
      const upstream = net.createConnection(socketPath);
      clients.add(upstream);
      client.setTimeout(0);
      const closePair = () => {
        client.destroy();
        upstream.destroy();
        clients.delete(client);
        clients.delete(upstream);
      };
      client.once("close", closePair);
      client.once("error", closePair);
      upstream.once("close", closePair);
      upstream.once("error", closePair);
      upstream.once("connect", () => {
        const rewritten = Buffer.concat([
          Buffer.from("GET /rpc HTTP/1.1"),
          buffered.subarray(requestLineEnd),
        ]);
        upstream.write(rewritten);
        client.pipe(upstream).pipe(client);
      });
    };
    client.on("data", consumeHandshake);
    client.once("close", () => {
      client.destroy();
      clients.delete(client);
    });
    client.once("error", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Codex daemon proxy did not expose a TCP address");
  }
  return {
    address,
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  if (index < 0) return DEFAULT_PORT;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

function readPathToken(argv: string[]): string {
  const index = argv.indexOf("--token-file");
  const tokenFile = index < 0 ? undefined : argv[index + 1];
  if (!tokenFile) throw new Error("--token-file is required");
  const stat = statSync(tokenFile);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Codex daemon proxy token file must not be accessible by group or others");
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Codex daemon proxy token must be 32 random bytes encoded as lowercase hex");
  }
  return token;
}

async function main(): Promise<void> {
  const socketPath = process.env.CODEX_DAEMON_SOCKET;
  const proxy = await startDaemonLoopbackProxy({
    ...(socketPath ? { socketPath } : {}),
    port: parsePort(process.argv.slice(2)),
    pathToken: readPathToken(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify({
    event: "codex_daemon_loopback_proxy_ready",
    host: proxy.address.address,
    port: proxy.address.port,
  })}\n`);
  const stop = () => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
