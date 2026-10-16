import * as schema from "../../database/schema";
import { db } from "../../database/client";
import { logDecision } from "../log";
import type { Db } from "./tx";

export type Actor = { memberId?: number | null; userId?: string | null };

/**
 * Append-only audit trail. Accepted events are written inside the operation's transaction so they
 * commit with it; rejected events are written on their own (the operation rolled back).
 * Summaries are safe one-liners — never passwords, tokens, document text or form contents.
 */
export async function audit(
  tx: Db,
  actor: Actor,
  event: { action: string; outcome: "accepted" | "rejected"; targetType?: string; targetId?: string | number | null; summary: string },
) {
  logDecision("audit", `${event.action} ${event.outcome}`, { actor: actor.memberId ?? null, target: event.targetType ? `${event.targetType}:${event.targetId ?? ""}` : undefined });
  await tx.insert(schema.auditEvents).values({
    actorMemberId: actor.memberId ?? null,
    actorUserId: actor.userId ?? null,
    action: event.action,
    outcome: event.outcome,
    targetType: event.targetType ?? null,
    targetId: event.targetId == null ? null : String(event.targetId),
    summary: event.summary.slice(0, 280),
  });
}

/** Records a rejection without letting an audit failure mask the original error. */
export async function auditRejection(actor: Actor, action: string, error: unknown, target?: { type: string; id?: string | number | null }) {
  const message = error instanceof Error ? error.message.split("\n")[0] : "rejected";
  try {
    await audit(db, actor, { action, outcome: "rejected", targetType: target?.type, targetId: target?.id, summary: message });
  } catch {
    logDecision("audit", "Could not persist rejection event", { action });
  }
}

/** Wraps a protected operation so both outcomes land in the audit trail. */
export async function audited<T>(actor: Actor, action: string, target: { type: string; id?: string | number | null } | undefined, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    await auditRejection(actor, action, error, target);
    throw error;
  }
}
