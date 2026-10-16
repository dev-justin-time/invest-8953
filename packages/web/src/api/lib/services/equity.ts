import { ORPCError } from "@orpc/server";
import { and, eq, gte, sql } from "drizzle-orm";
import * as schema from "../../database/schema";
import { logDecision } from "../log";
import type { Db } from "./tx";

/**
 * Ownership is conserved: every project's equity_positions sum to 10,000 bp. Equity is only ever
 * moved between positions (creator → backer on a primary ticket, seller → buyer on a trade);
 * nothing in the API can mint it.
 */

export const TOTAL_BP = 10000;

export async function openCreatorPosition(tx: Db, projectId: number, creatorId: number) {
  await tx.insert(schema.equityPositions).values({ projectId, memberId: creatorId, equityBp: TOTAL_BP, costCents: 0 });
}

export async function positionOf(tx: Db, projectId: number, memberId: number) {
  const [row] = await tx
    .select()
    .from(schema.equityPositions)
    .where(and(eq(schema.equityPositions.projectId, projectId), eq(schema.equityPositions.memberId, memberId)));
  return row?.equityBp ?? 0;
}

/** Bp a member has promised in open listings on this project. */
export async function committedBp(tx: Db, projectId: number, memberId: number) {
  const [row] = await tx
    .select({ bp: sql<number>`coalesce(sum(${schema.equityListings.equityBp}), 0)` })
    .from(schema.equityListings)
    .where(
      and(
        eq(schema.equityListings.projectId, projectId),
        eq(schema.equityListings.sellerId, memberId),
        eq(schema.equityListings.status, "open"),
      ),
    );
  return Number(row?.bp ?? 0);
}

export async function transferEquity(tx: Db, args: { projectId: number; fromMemberId: number; toMemberId: number; bp: number; costCents: number }) {
  if (!Number.isInteger(args.bp) || args.bp <= 0) throw new ORPCError("BAD_REQUEST", { message: "Equity must be a positive whole number of basis points" });
  if (args.fromMemberId === args.toMemberId) throw new ORPCError("BAD_REQUEST", { message: "Cannot transfer equity to the same holder" });
  const [from] = await tx
    .update(schema.equityPositions)
    .set({ equityBp: sql`${schema.equityPositions.equityBp} - ${args.bp}`, updatedAt: new Date() })
    .where(
      and(
        eq(schema.equityPositions.projectId, args.projectId),
        eq(schema.equityPositions.memberId, args.fromMemberId),
        gte(schema.equityPositions.equityBp, args.bp),
      ),
    )
    .returning({ equityBp: schema.equityPositions.equityBp });
  if (!from) {
    logDecision("equity", "Transfer refused: holder lacks equity", { projectId: args.projectId, from: args.fromMemberId, bp: args.bp });
    throw new ORPCError("BAD_REQUEST", { message: "The seller no longer holds that much equity" });
  }
  await tx
    .insert(schema.equityPositions)
    .values({ projectId: args.projectId, memberId: args.toMemberId, equityBp: args.bp, costCents: args.costCents })
    .onConflictDoUpdate({
      target: [schema.equityPositions.projectId, schema.equityPositions.memberId],
      set: {
        equityBp: sql`${schema.equityPositions.equityBp} + ${args.bp}`,
        costCents: sql`${schema.equityPositions.costCents} + ${args.costCents}`,
        updatedAt: new Date(),
      },
    });
  logDecision("equity", "Transferred", { projectId: args.projectId, from: args.fromMemberId, to: args.toMemberId, bp: args.bp });
}
