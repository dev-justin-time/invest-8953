import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../database/client";
import * as schema from "../../database/schema";
import { logDecision } from "../log";
import { runTx, type Tx } from "./tx";

/** Client-generated key attached to every financial mutation. */
export const idempotencyKey = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, "idempotency key must be URL-safe");

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function fingerprint(payload: unknown) {
  return createHash("sha256").update(stable(payload)).digest("hex");
}

function isUniqueViolation(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const c = current as { code?: string; message?: string; cause?: unknown };
    if (/UNIQUE constraint failed/i.test(c.message ?? "") || c.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    current = c.cause;
  }
  return false;
}

async function replay<T>(memberId: number, scope: string, key: string, print: string): Promise<{ hit: true; value: T } | { hit: false }> {
  const [row] = await db
    .select()
    .from(schema.idempotencyKeys)
    .where(and(eq(schema.idempotencyKeys.memberId, memberId), eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.key, key)));
  if (!row) return { hit: false };
  if (row.fingerprint !== print) {
    logDecision("idempotency", "Key reused with a different payload", { memberId, scope });
    throw new ORPCError("CONFLICT", { message: "This request key was already used for a different request. Refresh and try again." });
  }
  logDecision("idempotency", "Replayed original outcome", { memberId, scope });
  return { hit: true, value: JSON.parse(row.response) as T };
}

/**
 * Executes a financial mutation exactly once per (member, scope, key).
 * The key row is written inside the same transaction as the work, so a crash leaves neither,
 * and two concurrent requests with the same key cannot both commit (unique index).
 */
export async function once<T>(
  args: { memberId: number; scope: string; key: string; payload: unknown },
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const print = fingerprint(args.payload);
  const prior = await replay<T>(args.memberId, args.scope, args.key, print);
  if (prior.hit) return prior.value;
  try {
    return await runTx(args.scope, async (tx) => {
      const value = await work(tx);
      await tx.insert(schema.idempotencyKeys).values({
        memberId: args.memberId,
        scope: args.scope,
        key: args.key,
        fingerprint: print,
        response: JSON.stringify(value ?? null),
      });
      return value;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await replay<T>(args.memberId, args.scope, args.key, print);
      if (raced.hit) return raced.value;
    }
    throw error;
  }
}

export { isUniqueViolation };
