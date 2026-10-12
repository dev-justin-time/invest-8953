import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * Resilient database client.
 *
 * The default libSQL HTTP transport goes through cross-fetch → node-fetch v2,
 * which reuses keep-alive sockets the Turso edge has already closed. That shows
 * up as intermittent `ECONNRESET: socket hang up` 500s on the first requests
 * after a restart or an idle period.
 *
 * This client hands libSQL the platform fetch (undici on Node, native on Bun)
 * and retries a request only when it failed at the network layer before any
 * HTTP response arrived — a closed/stale socket, a refused connection or a
 * timeout. HTTP error statuses are never retried, so a request the database
 * answered is never replayed.
 *
 * App code imports `db` from "./database/client". The template export in
 * ./database (index → __client) stays intact for template tooling.
 */

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const MAX_ATTEMPTS = 3;

function networkCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const c = current as { code?: string; message?: string; cause?: unknown };
    if (c.code && RETRYABLE_CODES.has(c.code)) return c.code;
    if (typeof c.message === "string" && /socket hang up|other side closed/i.test(c.message)) return "ECONNRESET";
    current = c.cause;
  }
  return null;
}

type RequestLike = {
  url: string;
  method: string;
  headers: Iterable<[string, string]> | Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
};

async function resilientFetch(input: RequestLike | string | URL, init?: RequestInit): Promise<Response> {
  let url: string;
  let method = "GET";
  let headers: Record<string, string> = {};
  let body: ArrayBuffer | undefined;

  if (typeof input === "string" || input instanceof URL) {
    url = input.toString();
    method = init?.method ?? "GET";
    headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (init?.body != null) body = await new Response(init.body as BodyInit).arrayBuffer();
  } else {
    url = input.url;
    method = input.method;
    for (const [key, value] of input.headers as Iterable<[string, string]>) headers[key] = value;
    if (method !== "GET" && method !== "HEAD") body = await input.arrayBuffer();
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await globalThis.fetch(url, { method, headers, body });
      if (attempt > 1) console.info(`[db] request recovered on attempt ${attempt}`);
      return response;
    } catch (error) {
      lastError = error;
      const code = networkCode(error);
      if (!code || attempt === MAX_ATTEMPTS) break;
      console.warn(`[db] transient network failure (${code}), retrying ${attempt}/${MAX_ATTEMPTS - 1}`);
      await new Promise((resolve) => setTimeout(resolve, 60 * attempt));
    }
  }
  throw lastError;
}

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
  fetch: resilientFetch,
});

export const db = drizzle(client, { schema });
