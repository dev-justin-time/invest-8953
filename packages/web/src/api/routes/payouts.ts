import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { base } from "../middleware/errors";
import { db } from "../database";
import * as schema from "../database/schema";
import { daysFromNow, houseFeeCents } from "../lib/economy";
import {
  addLedger,
  addNotice,
  creditWallet,
  getMember,
  getProject,
  requireAdmin,
  takeHouseFee,
} from "../lib/helpers";

const CLOSED = ["foreclosed", "cancelled", "redistributed"];

/** Net crowd holdings for a project, grouped by member (after secondary trades). */
async function holdersOf(projectId: number) {
  const rows = await db
    .select()
    .from(schema.investments)
    .where(eq(schema.investments.projectId, projectId));
  const byMember = new Map<number, number>();
  for (const r of rows) byMember.set(r.memberId, (byMember.get(r.memberId) ?? 0) + r.equityBp);
  return [...byMember.entries()].filter(([, bp]) => bp > 0).map(([memberId, bp]) => ({ memberId, bp }));
}

/**
 * One income-share run. House takes 10% of gross; the rest splits by ownership:
 * holders get their basis points of the net, the creator keeps the remainder.
 */
export async function runDistribution(args: {
  projectId: number;
  grossCents: number;
  period: string;
  note?: string;
}) {
  const project = await getProject(args.projectId);
  const holders = await holdersOf(project.id);
  const crowdBp = holders.reduce((s, h) => s + h.bp, 0);
  const house = houseFeeCents(args.grossCents);
  const net = args.grossCents - house;

  let paid = 0;
  for (const h of holders) {
    const share = Math.floor((net * h.bp) / 10000);
    if (share <= 0) continue;
    paid += share;
    await creditWallet(h.memberId, share);
    await addLedger({
      kind: "income_share",
      amountCents: share,
      memberId: h.memberId,
      projectId: project.id,
      bucket: "member",
      note: `${args.period} income share — ${(h.bp / 100).toFixed(2)}% of ${project.title}`,
    });
  }
  const creatorCents = net - paid;
  logDecision("income", "Distribution partition", { projectId: project.id, gross: args.grossCents, house, paid, creatorCents });
  await creditWallet(project.creatorId, creatorCents);
  await addLedger({
    kind: "income_share",
    amountCents: creatorCents,
    memberId: project.creatorId,
    projectId: project.id,
    bucket: "creator",
    note: `${args.period} creator retained share of ${project.title}`,
  });
  await takeHouseFee({
    amountCents: args.grossCents,
    feeCents: house,
    memberId: project.creatorId,
    projectId: project.id,
    note: `Income distribution ${args.period}`,
  });

  const [row] = await db
    .insert(schema.distributions)
    .values({
      projectId: project.id,
      period: args.period,
      grossCents: args.grossCents,
      houseCents: house,
      holdersCents: paid,
      creatorCents,
      holderCount: holders.length,
      crowdBp,
      note: args.note ?? null,
    })
    .returning();

  await db
    .update(schema.projects)
    .set({ lastActivityAt: new Date() })
    .where(eq(schema.projects.id, project.id));

  return row;
}

/** Implied valuation from the most recent evidence available, with the method stated. */
async function markFor(project: typeof schema.projects.$inferSelect) {
  const [lastTrade] = await db
    .select()
    .from(schema.equityListings)
    .where(and(eq(schema.equityListings.projectId, project.id), eq(schema.equityListings.status, "filled")))
    .orderBy(desc(schema.equityListings.createdAt))
    .limit(1);
  if (lastTrade && lastTrade.equityBp > 0) {
    return { centsPerBp: lastTrade.askCents / lastTrade.equityBp, method: "last secondary trade" };
  }
  if (project.equityAllocatedBp > 0) {
    return { centsPerBp: project.raisedCents / project.equityAllocatedBp, method: "round price paid" };
  }
  return { centsPerBp: 0, method: "no price yet" };
}

export const payouts = {
  /** Creator reports simulated revenue for a period; holders are paid pro-rata. */
  report: base
    .input(
      z.object({
        memberId: z.number(),
        projectId: z.number(),
        grossCents: z.number().int().min(100).max(10_000_000),
        period: z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM"),
        note: z.string().max(500).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const project = await getProject(input.projectId);
      if (project.creatorId !== input.memberId) {
        throw new ORPCError("FORBIDDEN", { message: "Only the project owner reports revenue" });
      }
      if (CLOSED.includes(project.status)) {
        throw new ORPCError("BAD_REQUEST", { message: "Closed projects do not distribute" });
      }
      const [dupe] = await db
        .select()
        .from(schema.distributions)
        .where(
          and(eq(schema.distributions.projectId, project.id), eq(schema.distributions.period, input.period)),
        );
      if (dupe) {
        throw new ORPCError("CONFLICT", { message: `${input.period} has already been distributed` });
      }
      // Simulated: the reported revenue "arrives" in escrow, then splits. No real money moves.
      return runDistribution(input);
    }),

  /** Every run on a project — public, so backers can check the math. */
  history: base.input(z.object({ projectId: z.number() })).handler(({ input }) =>
    db
      .select()
      .from(schema.distributions)
      .where(eq(schema.distributions.projectId, input.projectId))
      .orderBy(desc(schema.distributions.createdAt)),
  ),

  /** Positions grouped by project: cost, ownership, income received, and an honest mark. */
  portfolio: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    await getMember(input.memberId);
    const invs = await db
      .select()
      .from(schema.investments)
      .where(eq(schema.investments.memberId, input.memberId));
    const projectIds = [...new Set(invs.map((i) => i.projectId))];
    if (!projectIds.length) {
      return { positions: [], totals: { costCents: 0, incomeCents: 0, markCents: 0, equityBp: 0 } };
    }
    const [projectRows, income] = await Promise.all([
      db.select().from(schema.projects).where(inArray(schema.projects.id, projectIds)),
      db
        .select()
        .from(schema.ledger)
        .where(and(eq(schema.ledger.memberId, input.memberId), eq(schema.ledger.kind, "income_share"))),
    ]);

    const positions = [];
    for (const p of projectRows) {
      const mine = invs.filter((i) => i.projectId === p.id);
      const equityBp = mine.reduce((s, i) => s + i.equityBp, 0);
      const costCents = mine.reduce((s, i) => s + i.amountCents, 0);
      const incomeCents = income.filter((l) => l.projectId === p.id).reduce((s, l) => s + l.amountCents, 0);
      const mark = await markFor(p);
      const markCents = CLOSED.includes(p.status) ? 0 : Math.round(equityBp * mark.centsPerBp);
      positions.push({
        projectId: p.id,
        title: p.title,
        brand: p.brand,
        status: p.status,
        stage: p.stage,
        equityBp,
        costCents,
        incomeCents,
        markCents,
        markMethod: CLOSED.includes(p.status) ? "closed — see notices" : mark.method,
      });
    }
    positions.sort((a, b) => b.costCents - a.costCents);
    return {
      positions,
      totals: {
        costCents: positions.reduce((s, p) => s + p.costCents, 0),
        incomeCents: positions.reduce((s, p) => s + p.incomeCents, 0),
        markCents: positions.reduce((s, p) => s + p.markCents, 0),
        equityBp: positions.reduce((s, p) => s + p.equityBp, 0),
      },
      disclaimer:
        "Marks are estimates from the last trade or round price. They are not offers, not appraisals, and nobody is obliged to buy at them.",
    };
  }),
};

/** Escrow reviewer desk: verify milestone evidence, release tranches, advance stages. */
export const escrow = {
  queue: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    await requireAdmin(input.memberId);
    const rows = await db
      .select({ milestone: schema.milestones, project: schema.projects })
      .from(schema.milestones)
      .innerJoin(schema.projects, eq(schema.milestones.projectId, schema.projects.id))
      .where(eq(schema.milestones.status, "submitted"));
    return rows.map((r) => ({
      ...r.milestone,
      projectTitle: r.project.title,
      escrowVendor: r.project.escrowVendor,
      raisedCents: r.project.raisedCents,
    }));
  }),

  review: base
    .input(
      z.object({
        memberId: z.number(),
        milestoneId: z.number(),
        approve: z.boolean(),
        note: z.string().min(5).max(800),
      }),
    )
    .handler(async ({ input }) => {
      await requireAdmin(input.memberId);
      const [ms] = await db.select().from(schema.milestones).where(eq(schema.milestones.id, input.milestoneId));
      if (!ms || ms.status !== "submitted") {
        throw new ORPCError("BAD_REQUEST", { message: "Nothing submitted on that milestone" });
      }
      const project = await getProject(ms.projectId);

      logDecision("escrow", "Evidence reviewed", { milestoneId: ms.id, approve: input.approve });
      if (!input.approve) {
        await db.update(schema.milestones).set({ status: "open" }).where(eq(schema.milestones.id, ms.id));
        await addNotice({
          memberId: project.creatorId,
          projectId: project.id,
          kind: "cure_plan",
          title: `${ms.title}: evidence needs another pass`,
          body: `Reviewer note: ${input.note}`,
          recoveryPath:
            "Nothing is penalised. Resubmit in the project room when ready — the clock resets on every submission.",
          dueAt: daysFromNow(21),
        });
        return { approved: false, releasedCents: 0, stage: project.stage };
      }

      await db
        .update(schema.milestones)
        .set({ status: "verified", verifiedAt: new Date() })
        .where(eq(schema.milestones.id, ms.id));

      const held = await db
        .select()
        .from(schema.investments)
        .where(and(eq(schema.investments.projectId, project.id), eq(schema.investments.escrowStatus, "held")));
      const tranche = held.reduce((s, i) => s + (i.amountCents - i.houseFeeCents), 0);
      if (held.length) {
        await db
          .update(schema.investments)
          .set({ escrowStatus: "released" })
          .where(inArray(schema.investments.id, held.map((h) => h.id)));
        await creditWallet(project.creatorId, tranche);
        await addLedger({
          kind: "escrow_release",
          amountCents: tranche,
          memberId: project.creatorId,
          projectId: project.id,
          bucket: "creator",
          note: `${ms.title} verified — ${held.length} tickets released by ${project.escrowVendor ?? "escrow"}`,
        });
      }

      const finalStage = ms.stage >= 5;
      const nextStage = finalStage ? 5 : ms.stage + 1;
      if (!finalStage) {
        await db
          .update(schema.milestones)
          .set({ status: "open", dueAt: daysFromNow(30) })
          .where(and(eq(schema.milestones.projectId, project.id), eq(schema.milestones.stage, nextStage)));
      }
      await db
        .update(schema.projects)
        .set({
          stage: nextStage,
          status: finalStage ? "funded" : project.status === "default_notice" ? "live" : project.status,
          lastActivityAt: new Date(),
        })
        .where(eq(schema.projects.id, project.id));

      const creator = await getMember(project.creatorId);
      await db
        .update(schema.members)
        .set({ trustScore: Math.min(1000, creator.trustScore + 12) })
        .where(eq(schema.members.id, creator.id));

      await addNotice({
        memberId: project.creatorId,
        projectId: project.id,
        kind: "reinstatement",
        title: `${ms.title} verified`,
        body: `$${(tranche / 100).toFixed(2)} released from escrow (simulated). ${
          finalStage ? "All five stages done — the round is funded." : `Stage ${nextStage} is open; point value has doubled.`
        }`,
      });

      return { approved: true, releasedCents: tranche, stage: nextStage };
    }),
};
