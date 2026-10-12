import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { base } from "../middleware/errors";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { houseFeeCents } from "../lib/economy";
import {
  addLedger,
  creditWallet,
  debitWallet,
  getMember,
  getProject,
  takeHouseFee,
} from "../lib/helpers";

const FLOOR_CENTS_PER_POINT = 2;

async function marketRate() {
  const filled = await db
    .select()
    .from(schema.pointListings)
    .where(eq(schema.pointListings.status, "filled"))
    .orderBy(desc(schema.pointListings.filledAt))
    .limit(20);
  const open = await db
    .select()
    .from(schema.pointListings)
    .where(eq(schema.pointListings.status, "open"));

  const volume = filled.reduce((s, f) => s + f.points, 0);
  const vwap = volume
    ? Math.round(filled.reduce((s, f) => s + f.points * f.priceCentsPerPoint, 0) / volume)
    : null;
  const bestAsk = open.length ? Math.min(...open.map((o) => o.priceCentsPerPoint)) : null;

  return {
    vwapCentsPerPoint: vwap ?? bestAsk ?? 5,
    bestAskCentsPerPoint: bestAsk,
    lastTrades: filled.slice(0, 8),
    openDepthPoints: open.reduce((s, o) => s + o.points, 0),
    floorCentsPerPoint: FLOOR_CENTS_PER_POINT,
    method:
      "Rate is the volume-weighted average of the last 20 fills. No oracle, no house quote — if nobody buys, the print does not exist.",
  };
}

export const exchange = {
  rate: base.handler(() => marketRate()),

  book: base.handler(async () => {
    const rows = await db
      .select({ listing: schema.pointListings, seller: schema.members })
      .from(schema.pointListings)
      .innerJoin(schema.members, eq(schema.pointListings.sellerId, schema.members.id))
      .where(eq(schema.pointListings.status, "open"))
      .orderBy(schema.pointListings.priceCentsPerPoint);
    return rows.map((r) => ({
      ...r.listing,
      sellerHandle: r.seller.handle,
      sellerLevel: r.seller.level,
    }));
  }),

  sellPoints: base
    .input(
      z.object({
        memberId: z.number(),
        points: z.number().min(10).max(50000),
        priceCentsPerPoint: z.number().min(FLOOR_CENTS_PER_POINT).max(500),
      }),
    )
    .handler(async ({ input }) => {
      const member = await getMember(input.memberId);
      if (member.points < input.points) {
        throw new ORPCError("BAD_REQUEST", {
          message: `You hold ${member.points} points, listing needs ${input.points}`,
        });
      }
      await db
        .update(schema.members)
        .set({ points: member.points - input.points })
        .where(eq(schema.members.id, member.id));
      const [listing] = await db
        .insert(schema.pointListings)
        .values({
          sellerId: member.id,
          points: input.points,
          priceCentsPerPoint: input.priceCentsPerPoint,
        })
        .returning();
      return listing;
    }),

  cancelListing: base
    .input(z.object({ memberId: z.number(), listingId: z.number() }))
    .handler(async ({ input }) => {
      const [listing] = await db
        .select()
        .from(schema.pointListings)
        .where(eq(schema.pointListings.id, input.listingId));
      if (!listing || listing.sellerId !== input.memberId) {
        throw new ORPCError("NOT_FOUND", { message: "Listing not found" });
      }
      if (listing.status !== "open") {
        throw new ORPCError("BAD_REQUEST", { message: "Listing is no longer open" });
      }
      const seller = await getMember(listing.sellerId);
      await db
        .update(schema.members)
        .set({ points: seller.points + listing.points })
        .where(eq(schema.members.id, seller.id));
      await db
        .update(schema.pointListings)
        .set({ status: "cancelled" })
        .where(eq(schema.pointListings.id, listing.id));
      return { ok: true };
    }),

  buyPoints: base
    .input(z.object({ memberId: z.number(), listingId: z.number() }))
    .handler(async ({ input }) => {
      const [listing] = await db
        .select()
        .from(schema.pointListings)
        .where(eq(schema.pointListings.id, input.listingId));
      if (!listing || listing.status !== "open") {
        throw new ORPCError("NOT_FOUND", { message: "That listing is gone" });
      }
      if (listing.sellerId === input.memberId) {
        throw new ORPCError("BAD_REQUEST", { message: "You cannot fill your own ask" });
      }
      const gross = listing.points * listing.priceCentsPerPoint;
      const fee = houseFeeCents(gross);
      const buyer = await getMember(input.memberId);

      await debitWallet(buyer.id, gross, "points purchase");
      await creditWallet(listing.sellerId, gross - fee);
      await db
        .update(schema.members)
        .set({ points: buyer.points + listing.points })
        .where(eq(schema.members.id, buyer.id));
      await db
        .update(schema.pointListings)
        .set({ status: "filled", buyerId: buyer.id, filledAt: new Date() })
        .where(eq(schema.pointListings.id, listing.id));

      await addLedger({
        kind: "points_trade",
        amountCents: gross,
        memberId: buyer.id,
        bucket: "member",
        note: `${listing.points} points at ${listing.priceCentsPerPoint}c — seller nets $${((gross - fee) / 100).toFixed(2)}`,
      });
      await takeHouseFee({
        amountCents: gross,
        feeCents: fee,
        memberId: buyer.id,
        note: "Points trade",
      });

      return { pointsBought: listing.points, paidCents: gross, sellerNetCents: gross - fee, houseFeeCents: fee };
    }),

  /** Equity Book — resale of project equity, including foreclosure lots. */
  equityBook: base.handler(async () => {
    const rows = await db
      .select({
        listing: schema.equityListings,
        project: schema.projects,
        seller: schema.members,
      })
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
      isForeclosureLot: r.listing.status === "foreclosed_lot" || r.seller.role === "admin",
    }));
  }),

  listEquity: base
    .input(
      z.object({
        memberId: z.number(),
        projectId: z.number(),
        equityBp: z.number().min(1).max(10000),
        askCents: z.number().min(100).max(10000000),
      }),
    )
    .handler(async ({ input }) => {
      const project = await getProject(input.projectId);
      const member = await getMember(input.memberId);
      const held =
        project.creatorId === member.id
          ? 10000 - project.equityAllocatedBp
          : (
              await db
                .select()
                .from(schema.investments)
                .where(
                  and(
                    eq(schema.investments.memberId, member.id),
                    eq(schema.investments.projectId, project.id),
                  ),
                )
            ).reduce((s, i) => s + i.equityBp, 0);

      if (held < input.equityBp) {
        throw new ORPCError("BAD_REQUEST", {
          message: `You hold ${(held / 100).toFixed(2)}% here, listing needs ${(input.equityBp / 100).toFixed(2)}%`,
        });
      }
      const openLots = await db.select().from(schema.equityListings).where(and(eq(schema.equityListings.sellerId, member.id), eq(schema.equityListings.projectId, project.id), eq(schema.equityListings.status, "open")));
      const committed = openLots.reduce((sum, lot) => sum + lot.equityBp, 0);
      if (held - committed < input.equityBp) {
        throw new ORPCError("CONFLICT", { message: "Some of this stake is already committed to open listings." });
      }

      const [listing] = await db
        .insert(schema.equityListings)
        .values({
          projectId: project.id,
          sellerId: member.id,
          equityBp: input.equityBp,
          askCents: input.askCents,
        })
        .returning();
      return listing;
    }),

  buyEquity: base
    .input(z.object({ memberId: z.number(), listingId: z.number() }))
    .handler(async ({ input }) => {
      const [listing] = await db
        .select()
        .from(schema.equityListings)
        .where(eq(schema.equityListings.id, input.listingId));
      if (!listing || !["open", "foreclosed_lot"].includes(listing.status)) {
        throw new ORPCError("NOT_FOUND", { message: "That lot is gone" });
      }
      const buyer = await getMember(input.memberId);
      if (buyer.id === listing.sellerId) throw new ORPCError("BAD_REQUEST", { message: "You cannot buy your own listing." });
      if (buyer.level < 2) {
        throw new ORPCError("FORBIDDEN", {
          message: "The Equity Book opens at Operator (Level 2). Points or a $29 unlock get you there.",
        });
      }
      const project = await getProject(listing.projectId);
      if (project.brand === "orbital" && buyer.kycStatus !== "accredited" && buyer.level < 4 && buyer.role !== "admin") {
        throw new ORPCError("FORBIDDEN", { message: "Orbital equity requires accredited status." });
      }
      const fee = houseFeeCents(listing.askCents);

      await debitWallet(buyer.id, listing.askCents, "equity purchase");
      if (listing.sellerId !== buyer.id) await creditWallet(listing.sellerId, listing.askCents - fee);

      // Move the basis points: reduce the seller's rows, write the buyer a secondary position.
      let remaining = listing.equityBp;
      const sellerRows = await db
        .select()
        .from(schema.investments)
        .where(
          and(
            eq(schema.investments.memberId, listing.sellerId),
            eq(schema.investments.projectId, project.id),
          ),
        );
      for (const row of sellerRows) {
        if (remaining <= 0) break;
        const take = Math.min(row.equityBp, remaining);
        remaining -= take;
        await db
          .update(schema.investments)
          .set({ equityBp: row.equityBp - take })
          .where(eq(schema.investments.id, row.id));
      }
      if (remaining > 0 && listing.sellerId === project.creatorId) {
        await db.update(schema.projects).set({ equityAllocatedBp: project.equityAllocatedBp + remaining }).where(eq(schema.projects.id, project.id));
      }

      await db.insert(schema.investments).values({
        projectId: project.id,
        memberId: buyer.id,
        amountCents: listing.askCents,
        pointsAwarded: 0,
        equityBp: listing.equityBp,
        stage: project.stage,
        houseFeeCents: fee,
        escrowStatus: "released",
      });
      await db
        .update(schema.equityListings)
        .set({ status: "filled", buyerId: buyer.id })
        .where(eq(schema.equityListings.id, listing.id));

      await addLedger({
        kind: "equity_trade",
        amountCents: listing.askCents,
        memberId: buyer.id,
        projectId: project.id,
        bucket: "member",
        note: `${(listing.equityBp / 100).toFixed(2)}% of ${project.title} on the secondary`,
      });
      await takeHouseFee({
        amountCents: listing.askCents,
        feeCents: fee,
        memberId: buyer.id,
        projectId: project.id,
        note: "Equity trade",
      });

      return { equityBp: listing.equityBp, paidCents: listing.askCents, houseFeeCents: fee };
    }),

  myListings: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    const [points, equity] = await Promise.all([
      db
        .select()
        .from(schema.pointListings)
        .where(eq(schema.pointListings.sellerId, input.memberId))
        .orderBy(desc(schema.pointListings.createdAt)),
      db
        .select()
        .from(schema.equityListings)
        .where(eq(schema.equityListings.sellerId, input.memberId))
        .orderBy(desc(schema.equityListings.createdAt)),
    ]);
    return { points, equity };
  }),
};
