import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { actorOf, memberProc, publicProc } from "../middleware/auth";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { audit, audited } from "../lib/services/audit";
import { committedBp, positionOf, transferEquity } from "../lib/services/equity";
import { idempotencyKey, once } from "../lib/services/idempotency";
import { addLedger, bookFee, tradeFee } from "../lib/services/ledger";
import { isAccredited, lockProject } from "../lib/services/tickets";
import { runTx } from "../lib/services/tx";
import { credit, debit, grantPoints, spendPoints, usd } from "../lib/services/wallet";

const FLOOR_CENTS_PER_POINT = 2;

async function marketRate() {
  const filled = await db
    .select()
    .from(schema.pointListings)
    .where(eq(schema.pointListings.status, "filled"))
    .orderBy(desc(schema.pointListings.filledAt))
    .limit(20);
  const open = await db.select().from(schema.pointListings).where(eq(schema.pointListings.status, "open"));
  const volume = filled.reduce((s, f) => s + f.points, 0);
  const vwap = volume ? Math.round(filled.reduce((s, f) => s + f.points * f.priceCentsPerPoint, 0) / volume) : null;
  const bestAsk = open.length ? Math.min(...open.map((o) => o.priceCentsPerPoint)) : null;
  return {
    vwapCentsPerPoint: vwap ?? bestAsk ?? 5,
    bestAskCentsPerPoint: bestAsk,
    lastTrades: filled.slice(0, 8).map((f) => ({ id: f.id, points: f.points, priceCentsPerPoint: f.priceCentsPerPoint, filledAt: f.filledAt })),
    openDepthPoints: open.reduce((s, o) => s + o.points, 0),
    floorCentsPerPoint: FLOOR_CENTS_PER_POINT,
    method: "Rate is the volume-weighted average of the last 20 fills. No oracle, no house quote — if nobody buys, the print does not exist.",
  };
}

const isForeclosureLot = (l: { lotKind: string; status: string }) => l.lotKind === "foreclosure" || l.status === "foreclosed_lot";

export const exchange = {
  rate: publicProc.handler(() => marketRate()),

  book: publicProc.handler(async () => {
    const rows = await db
      .select({ listing: schema.pointListings, seller: schema.members })
      .from(schema.pointListings)
      .innerJoin(schema.members, eq(schema.pointListings.sellerId, schema.members.id))
      .where(eq(schema.pointListings.status, "open"))
      .orderBy(schema.pointListings.priceCentsPerPoint);
    return rows.map((r) => ({ ...r.listing, sellerHandle: r.seller.handle, sellerLevel: r.seller.level }));
  }),

  /** Points are escrowed off the seller's balance the moment the ask is posted. */
  sellPoints: memberProc
    .input(z.object({ points: z.number().int().min(10).max(50000), priceCentsPerPoint: z.number().int().min(FLOOR_CENTS_PER_POINT).max(500), idempotencyKey }))
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "exchange.sellPoints", undefined, () =>
        once({ memberId: context.member.id, scope: "exchange.sellPoints", key, payload }, async (tx) => {
          await spendPoints(tx, context.member.id, input.points, "points ask");
          const [listing] = await tx
            .insert(schema.pointListings)
            .values({ sellerId: context.member.id, points: input.points, priceCentsPerPoint: input.priceCentsPerPoint })
            .returning();
          await audit(tx, actorOf(context), { action: "exchange.sellPoints", outcome: "accepted", targetType: "point_listing", targetId: listing.id, summary: `${input.points} pts at ${input.priceCentsPerPoint}c` });
          return listing;
        }),
      );
    }),

  cancelListing: memberProc.input(z.object({ listingId: z.number().int() })).handler(({ input, context }) =>
    audited(actorOf(context), "exchange.cancelListing", { type: "point_listing", id: input.listingId }, () =>
      runTx("exchange.cancelListing", async (tx) => {
        const [listing] = await tx
          .update(schema.pointListings)
          .set({ status: "cancelled" })
          .where(and(eq(schema.pointListings.id, input.listingId), eq(schema.pointListings.sellerId, context.member.id), eq(schema.pointListings.status, "open")))
          .returning();
        if (!listing) throw new ORPCError("NOT_FOUND", { message: "No open listing of yours with that id" });
        await grantPoints(tx, context.member.id, listing.points);
        await audit(tx, actorOf(context), { action: "exchange.cancelListing", outcome: "accepted", targetType: "point_listing", targetId: listing.id, summary: `${listing.points} pts returned` });
        return { ok: true, pointsReturned: listing.points };
      }),
    ),
  ),

  /** Fill an ask: the status flip is conditional, so two buyers can never both fill it. */
  buyPoints: memberProc.input(z.object({ listingId: z.number().int(), idempotencyKey })).handler(({ input, context }) => {
    const { idempotencyKey: key, ...payload } = input;
    return audited(actorOf(context), "exchange.buyPoints", { type: "point_listing", id: input.listingId }, () =>
      once({ memberId: context.member.id, scope: "exchange.buyPoints", key, payload }, async (tx) => {
        const [listing] = await tx
          .update(schema.pointListings)
          .set({ status: "filled", buyerId: context.member.id, filledAt: new Date() })
          .where(and(eq(schema.pointListings.id, input.listingId), eq(schema.pointListings.status, "open"), sql`${schema.pointListings.sellerId} <> ${context.member.id}`))
          .returning();
        if (!listing) throw new ORPCError("NOT_FOUND", { message: "That listing is gone, or it is your own ask" });
        const gross = listing.points * listing.priceCentsPerPoint;
        const fee = tradeFee(gross);
        await debit(tx, context.member.id, gross, `${listing.points} points`);
        await credit(tx, listing.sellerId, gross - fee.feeCents, `sold ${listing.points} points`);
        await grantPoints(tx, context.member.id, listing.points);
        await addLedger(tx, { kind: "points_trade", amountCents: gross - fee.feeCents, memberId: listing.sellerId, bucket: "member", note: `${listing.points} pts at ${listing.priceCentsPerPoint}c — seller net` });
        await bookFee(tx, { kind: "house_fee", feeCents: fee.feeCents, memberId: context.member.id, note: "Points trade" });
        await audit(tx, actorOf(context), { action: "exchange.buyPoints", outcome: "accepted", targetType: "point_listing", targetId: listing.id, summary: `${listing.points} pts for ${gross}c` });
        return { pointsBought: listing.points, paidCents: gross, sellerNetCents: gross - fee.feeCents, houseFeeCents: fee.feeCents };
      }),
    );
  }),

  /** Equity Book — resale of existing equity, including foreclosure lots. */
  equityBook: publicProc.handler(async () => {
    const rows = await db
      .select({ listing: schema.equityListings, project: schema.projects, seller: schema.members })
      .from(schema.equityListings)
      .innerJoin(schema.projects, eq(schema.equityListings.projectId, schema.projects.id))
      .innerJoin(schema.members, eq(schema.equityListings.sellerId, schema.members.id))
      .where(inArray(schema.equityListings.status, ["open", "foreclosed_lot"]))
      .orderBy(desc(schema.equityListings.createdAt));
    return rows.map((r) => ({
      ...r.listing,
      projectTitle: r.project.title,
      projectStage: r.project.stage,
      projectStatus: r.project.status,
      projectBrand: r.project.brand,
      sellerHandle: r.seller.handle,
      isForeclosureLot: isForeclosureLot(r.listing),
    }));
  }),

  /** List part of a stake you hold. Open listings can never promise more than the position. */
  listEquity: memberProc
    .input(z.object({ projectId: z.number().int(), equityBp: z.number().int().min(1).max(10000), askCents: z.number().int().min(100).max(10000000), idempotencyKey }))
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "exchange.listEquity", { type: "project", id: input.projectId }, () =>
        once({ memberId: context.member.id, scope: "exchange.listEquity", key, payload }, async (tx) => {
          const project = await lockProject(tx, input.projectId);
          if (["foreclosed", "redistributed", "cancelled"].includes(project.status)) {
            throw new ORPCError("BAD_REQUEST", { message: "This project is closed out; its stakes cannot be listed" });
          }
          const held = await positionOf(tx, project.id, context.member.id);
          const committed = await committedBp(tx, project.id, context.member.id);
          if (held - committed < input.equityBp) {
            throw new ORPCError("BAD_REQUEST", {
              message: `You hold ${(held / 100).toFixed(2)}% here with ${(committed / 100).toFixed(2)}% already listed; this listing needs ${(input.equityBp / 100).toFixed(2)}%`,
            });
          }
          const [listing] = await tx
            .insert(schema.equityListings)
            .values({ projectId: project.id, sellerId: context.member.id, equityBp: input.equityBp, askCents: input.askCents, lotKind: "member" })
            .returning();
          await audit(tx, actorOf(context), { action: "exchange.listEquity", outcome: "accepted", targetType: "equity_listing", targetId: listing.id, summary: `${input.equityBp} bp of #${project.id} for ${input.askCents}c` });
          return listing;
        }),
      );
    }),

  cancelEquityListing: memberProc.input(z.object({ listingId: z.number().int() })).handler(({ input, context }) =>
    audited(actorOf(context), "exchange.cancelEquityListing", { type: "equity_listing", id: input.listingId }, () =>
      runTx("exchange.cancelEquityListing", async (tx) => {
        const [listing] = await tx
          .update(schema.equityListings)
          .set({ status: "cancelled" })
          .where(and(eq(schema.equityListings.id, input.listingId), eq(schema.equityListings.sellerId, context.member.id), eq(schema.equityListings.status, "open"), eq(schema.equityListings.lotKind, "member")))
          .returning();
        if (!listing) throw new ORPCError("NOT_FOUND", { message: "No open listing of yours with that id" });
        await audit(tx, actorOf(context), { action: "exchange.cancelEquityListing", outcome: "accepted", targetType: "equity_listing", targetId: listing.id, summary: "Withdrawn" });
        return { ok: true };
      }),
    ),
  ),

  /**
   * Buy a lot: existing equity moves seller → buyer. A member lot pays the seller (less 10%);
   * a foreclosure lot pays the feature fund — never a personal wallet.
   */
  buyEquity: memberProc.input(z.object({ listingId: z.number().int(), idempotencyKey })).handler(({ input, context }) => {
    const { idempotencyKey: key, ...payload } = input;
    return audited(actorOf(context), "exchange.buyEquity", { type: "equity_listing", id: input.listingId }, () =>
      once({ memberId: context.member.id, scope: "exchange.buyEquity", key, payload }, async (tx) => {
        const [buyer] = await tx.select().from(schema.members).where(eq(schema.members.id, context.member.id));
        if (buyer.level < 2) throw new ORPCError("FORBIDDEN", { message: "The Equity Book opens at Operator (Level 2). Points or a $29 unlock get you there." });
        const [listing] = await tx
          .update(schema.equityListings)
          .set({ status: "filled", buyerId: buyer.id, filledAt: new Date() })
          .where(and(eq(schema.equityListings.id, input.listingId), inArray(schema.equityListings.status, ["open", "foreclosed_lot"]), sql`${schema.equityListings.sellerId} <> ${buyer.id}`))
          .returning();
        if (!listing) throw new ORPCError("NOT_FOUND", { message: "That lot is gone, or it is your own listing" });
        const project = await lockProject(tx, listing.projectId);
        if (project.brand === "orbital" && !isAccredited(buyer)) {
          throw new ORPCError("FORBIDDEN", { message: "Orbital equity needs administrator-approved simulated accreditation." });
        }
        const fee = tradeFee(listing.askCents);
        const foreclosure = isForeclosureLot(listing);
        await debit(tx, buyer.id, listing.askCents, `equity lot #${listing.id}`, project.id);
        await transferEquity(tx, { projectId: project.id, fromMemberId: listing.sellerId, toMemberId: buyer.id, bp: listing.equityBp, costCents: listing.askCents });
        if (foreclosure) {
          await addLedger(tx, { kind: "feature_funding", amountCents: listing.askCents - fee.feeCents, projectId: project.id, bucket: "feature_fund", note: `Foreclosure lot #${listing.id} proceeds` });
        } else {
          await credit(tx, listing.sellerId, listing.askCents - fee.feeCents, `sold equity lot #${listing.id}`, project.id);
          await addLedger(tx, { kind: "equity_trade", amountCents: listing.askCents - fee.feeCents, memberId: listing.sellerId, projectId: project.id, bucket: "member", note: `${(listing.equityBp / 100).toFixed(2)}% of ${project.title} — seller net` });
        }
        await bookFee(tx, { kind: "house_fee", feeCents: fee.feeCents, memberId: buyer.id, projectId: project.id, note: "Equity trade" });
        await audit(tx, actorOf(context), { action: "exchange.buyEquity", outcome: "accepted", targetType: "equity_listing", targetId: listing.id, summary: `${listing.equityBp} bp for ${usd(listing.askCents)}${foreclosure ? " (foreclosure lot)" : ""}` });
        return { equityBp: listing.equityBp, paidCents: listing.askCents, houseFeeCents: fee.feeCents, proceedsTo: foreclosure ? "feature_fund" : "seller" };
      }),
    );
  }),

  myListings: memberProc.handler(async ({ context }) => {
    const [points, equity] = await Promise.all([
      db.select().from(schema.pointListings).where(eq(schema.pointListings.sellerId, context.member.id)).orderBy(desc(schema.pointListings.createdAt)),
      db.select().from(schema.equityListings).where(eq(schema.equityListings.sellerId, context.member.id)).orderBy(desc(schema.equityListings.createdAt)),
    ]);
    return { points, equity };
  }),
};
