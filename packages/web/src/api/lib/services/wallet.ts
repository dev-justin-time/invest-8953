import { ORPCError } from "@orpc/server";
import { and, eq, gte, sql } from "drizzle-orm";
import * as schema from "../../database/schema";
import { logDecision } from "../log";
import type { Db } from "./tx";

/** Simulated club-credit wallet. Integer cents only; balances can never go negative. */

function assertCents(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ORPCError("BAD_REQUEST", { message: `${label} must be a whole, non-negative number of cents` });
  }
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Conditional debit: the UPDATE only matches while the balance covers the amount, so races cannot overdraw. */
export async function debit(tx: Db, memberId: number, amountCents: number, reason: string, projectId?: number | null) {
  assertCents(amountCents, "Debit");
  if (amountCents === 0) return currentBalance(tx, memberId);
  const [row] = await tx
    .update(schema.members)
    .set({ walletCents: sql`${schema.members.walletCents} - ${amountCents}` })
    .where(and(eq(schema.members.id, memberId), gte(schema.members.walletCents, amountCents)))
    .returning({ walletCents: schema.members.walletCents });
  if (!row) {
    const balance = await currentBalance(tx, memberId);
    logDecision("wallet", "Debit refused: insufficient simulated credit", { memberId, amountCents, reason });
    throw new ORPCError("BAD_REQUEST", {
      message: `Simulated wallet short by ${usd(amountCents - balance)} for ${reason}`,
    });
  }
  await tx.insert(schema.walletEntries).values({
    memberId,
    deltaCents: -amountCents,
    balanceAfterCents: row.walletCents,
    reason,
    projectId: projectId ?? null,
  });
  logDecision("wallet", "Debited", { memberId, amountCents, reason });
  return row.walletCents;
}

export async function credit(tx: Db, memberId: number, amountCents: number, reason: string, projectId?: number | null) {
  assertCents(amountCents, "Credit");
  if (amountCents === 0) return currentBalance(tx, memberId);
  const [row] = await tx
    .update(schema.members)
    .set({ walletCents: sql`${schema.members.walletCents} + ${amountCents}` })
    .where(eq(schema.members.id, memberId))
    .returning({ walletCents: schema.members.walletCents });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Wallet owner not found" });
  await tx.insert(schema.walletEntries).values({
    memberId,
    deltaCents: amountCents,
    balanceAfterCents: row.walletCents,
    reason,
    projectId: projectId ?? null,
  });
  logDecision("wallet", "Credited", { memberId, amountCents, reason });
  return row.walletCents;
}

export async function currentBalance(tx: Db, memberId: number) {
  const [row] = await tx
    .select({ walletCents: schema.members.walletCents })
    .from(schema.members)
    .where(eq(schema.members.id, memberId));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Wallet owner not found" });
  return row.walletCents;
}

/** Points move the same way: conditional, never negative. */
export async function spendPoints(tx: Db, memberId: number, points: number, reason: string) {
  if (!Number.isInteger(points) || points <= 0) throw new ORPCError("BAD_REQUEST", { message: "Points must be a positive whole number" });
  const [row] = await tx
    .update(schema.members)
    .set({ points: sql`${schema.members.points} - ${points}` })
    .where(and(eq(schema.members.id, memberId), gte(schema.members.points, points)))
    .returning({ points: schema.members.points });
  if (!row) {
    logDecision("points", "Spend refused: insufficient points", { memberId, points, reason });
    throw new ORPCError("BAD_REQUEST", { message: `Not enough points for ${reason}` });
  }
  logDecision("points", "Spent", { memberId, points, reason });
  return row.points;
}

export async function grantPoints(tx: Db, memberId: number, points: number, clout = 0) {
  await tx
    .update(schema.members)
    .set({
      points: sql`${schema.members.points} + ${points}`,
      clout: sql`${schema.members.clout} + ${clout}`,
    })
    .where(eq(schema.members.id, memberId));
}
