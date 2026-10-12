import { db } from "../../database/client";
import { logDecision } from "../log";

/** A drizzle transaction handle. Every service takes one so callers compose a single atomic unit. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Db = typeof db | Tx;

function isBusy(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const c = current as { code?: string; message?: string; cause?: unknown };
    if (c.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(c.message ?? "")) return true;
    current = c.cause;
  }
  return false;
}

/**
 * Runs `work` as one write transaction: everything commits or nothing does.
 * A transaction that lost a lock race (SQLITE_BUSY) was fully rolled back, so it is
 * retried a couple of times; any other error propagates unchanged.
 */
export async function runTx<T>(label: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await db.transaction(work);
      logDecision("tx", `${label} committed`, attempt > 1 ? { attempt } : undefined);
      return result;
    } catch (error) {
      if (isBusy(error) && attempt < 3) {
        logDecision("tx", `${label} busy, retrying`, { attempt });
        await new Promise((resolve) => setTimeout(resolve, 80 * attempt));
        continue;
      }
      logDecision("tx", `${label} rolled back`, { reason: error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "unknown" });
      throw error;
    }
  }
}
