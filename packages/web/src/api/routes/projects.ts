import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { base } from "../middleware/errors";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  CANCEL_CLAWBACK_RATE,
  ESCROW_FEE_CENTS,
  GRACE_DAYS,
  daysFromNow,
  pitchFeeCents,
  pointValueForStage,
} from "../lib/economy";
import {
  addLedger,
  addNotice,
  creditWallet,
  debitWallet,
  getMember,
  getProject,
  takeHouseFee,
} from "../lib/helpers";

const riskEnum = z.enum(["low", "medium", "high"]);
const brandEnum = z.enum(["forge", "orbital", "sole"]);

const ESCROW_VENDORS = [
  "Harbor & Vale Escrow (Wilmington, DE)",
  "Sierra Trust Services (Reno, NV)",
  "Meridian Fiduciary (Austin, TX)",
  "Northbridge Escrow Co. (Chicago, IL)",
  "Coastline Settlement Group (Tampa, FL)",
];

const MILESTONE_TEMPLATES = [
  { title: "Stage 1 — Proof it exists", requirement: "Working artifact, footage, or signed letter of intent posted to the project room." },
  { title: "Stage 2 — Proof someone wants it", requirement: "First paying customer, pre-order, or grant, with receipts in escrow." },
  { title: "Stage 3 — Proof it repeats", requirement: "Three consecutive months of revenue or a filed IP asset with an examiner number." },
  { title: "Stage 4 — Proof it scales", requirement: "Unit economics sheet plus a fulfilment or manufacturing agreement." },
  { title: "Stage 5 — Proof it pays members", requirement: "First distribution run through escrow to equity holders." },
];

export const projects = {
  feeQuote: base
    .input(z.object({ capitalGoalCents: z.number().min(10000), riskTier: riskEnum }))
    .handler(({ input }) => {
      const fee = pitchFeeCents(input.capitalGoalCents, input.riskTier);
      return {
        pitchFeeCents: fee,
        escrowFeeCents: ESCROW_FEE_CENTS,
        totalCents: fee + ESCROW_FEE_CENTS,
        clawbackRate: CANCEL_CLAWBACK_RATE,
        explanation:
          "Pitch fee is $10 base plus a capital-goal and risk scale. Low risk at a $10,000 goal is $99. Escrow is a flat $200 paid to the vetted professional, not to the house. Cancel after money is raised and 25% of the raise is retained: three quarters of that goes back to backers, the rest splits between the house and the redistribution pool.",
      };
    }),

  list: base
    .input(
      z
        .object({
          brand: brandEnum.optional(),
          status: z.string().optional(),
          category: z.string().optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const rows = await db
        .select({ project: schema.projects, creator: schema.members })
        .from(schema.projects)
        .innerJoin(schema.members, eq(schema.projects.creatorId, schema.members.id))
        .orderBy(desc(schema.projects.createdAt));
      return rows
        .filter((r) => (input?.brand ? r.project.brand === input.brand : true))
        .filter((r) => (input?.status ? r.project.status === input.status : true))
        .filter((r) => (input?.category ? r.project.category === input.category : true))
        .map((r) => ({
          ...r.project,
          creatorHandle: r.creator.handle,
          creatorName: r.creator.displayName,
        }));
    }),

  get: base
    .input(z.object({ projectId: z.number(), viewerId: z.number().optional() }))
    .handler(async ({ input }) => {
      const project = await getProject(input.projectId);
      const creator = await getMember(project.creatorId);
      const [ms, invs, cmts, equity] = await Promise.all([
        db
          .select()
          .from(schema.milestones)
          .where(eq(schema.milestones.projectId, project.id))
          .orderBy(schema.milestones.stage),
        db
          .select({ investment: schema.investments, member: schema.members })
          .from(schema.investments)
          .innerJoin(schema.members, eq(schema.investments.memberId, schema.members.id))
          .where(eq(schema.investments.projectId, project.id))
          .orderBy(desc(schema.investments.createdAt)),
        db
          .select({ comment: schema.comments, member: schema.members })
          .from(schema.comments)
          .innerJoin(schema.members, eq(schema.comments.memberId, schema.members.id))
          .where(eq(schema.comments.projectId, project.id))
          .orderBy(desc(schema.comments.createdAt)),
        db
          .select()
          .from(schema.equityListings)
          .where(
            and(eq(schema.equityListings.projectId, project.id), eq(schema.equityListings.status, "open")),
          ),
      ]);

      const viewerPosition = input.viewerId
        ? invs.filter((i) => i.investment.memberId === input.viewerId)
        : [];

      return {
        project,
        creator: {
          handle: creator.handle,
          displayName: creator.displayName,
          level: creator.level,
        },
        milestones: ms,
        pointValueNow: pointValueForStage(project.stage),
        backers: invs.map((i) => ({
          ...i.investment,
          handle: i.member.handle,
          displayName: i.member.displayName,
        })),
        comments: cmts.map((c) => ({
          ...c.comment,
          handle: c.member.handle,
          displayName: c.member.displayName,
          level: c.member.level,
        })),
        equityBook: equity,
        viewer: {
          investedCents: viewerPosition.reduce((s, p) => s + p.investment.amountCents, 0),
          equityBp: viewerPosition.reduce((s, p) => s + p.investment.equityBp, 0),
          points: viewerPosition.reduce((s, p) => s + p.investment.pointsAwarded, 0),
        },
      };
    }),

  /** Pitch anything legal. Fee scales with risk and capital goal; house takes 10% of the fee. */
  pitch: base
    .input(
      z.object({
        memberId: z.number(),
        title: z.string().min(3).max(80),
        tagline: z.string().min(8).max(140),
        description: z.string().min(40).max(4000),
        brand: brandEnum.default("forge"),
        category: z.string().default("other"),
        riskTier: riskEnum,
        capitalGoalCents: z.number().min(10000).max(100000000),
        pitchFormat: z.enum(["video", "deck", "drawing", "prototype", "writeup"]),
        pitchUrl: z.string().url().optional(),
        equityOfferedBp: z.number().min(100).max(5000).default(1000),
        acceptTerms: z.literal(true),
      }),
    )
    .handler(async ({ input }) => {
      const member = await getMember(input.memberId);
      const fee = pitchFeeCents(input.capitalGoalCents, input.riskTier);
      const due = fee + ESCROW_FEE_CENTS;
      await debitWallet(member.id, due, "pitch listing + escrow retainer");

      const vendor = ESCROW_VENDORS[Math.floor(Math.random() * ESCROW_VENDORS.length)];
      const [project] = await db
        .insert(schema.projects)
        .values({
          creatorId: member.id,
          title: input.title,
          tagline: input.tagline,
          description: input.description,
          brand: input.brand,
          category: input.category,
          riskTier: input.riskTier,
          capitalGoalCents: input.capitalGoalCents,
          pitchFeeCents: fee,
          pitchFormat: input.pitchFormat,
          pitchUrl: input.pitchUrl ?? null,
          equityOfferedBp: input.equityOfferedBp,
          escrowVendor: vendor,
          escrowFeeCents: ESCROW_FEE_CENTS,
          escrowStatus: "assigned",
          status: "live",
          stage: 1,
        })
        .returning();

      await db.insert(schema.milestones).values(
        MILESTONE_TEMPLATES.map((m, i) => ({
          projectId: project.id,
          stage: i + 1,
          title: m.title,
          requirement: m.requirement,
          pointValue: pointValueForStage(i + 1),
          status: i === 0 ? "open" : "locked",
          dueAt: daysFromNow(30 * (i + 1)),
        })),
      );

      await addLedger({
        kind: "pitch_fee",
        amountCents: fee,
        memberId: member.id,
        projectId: project.id,
        bucket: "house",
        note: `Pitch listing fee (${input.riskTier} risk, $${(input.capitalGoalCents / 100).toLocaleString()} goal)`,
      });
      await takeHouseFee({
        amountCents: fee,
        feeCents: Math.round(fee * 0.1),
        memberId: member.id,
        projectId: project.id,
        note: "Pitch listing fee",
      });
      await addLedger({
        kind: "escrow_fee",
        amountCents: ESCROW_FEE_CENTS,
        memberId: member.id,
        projectId: project.id,
        bucket: "escrow",
        note: `Escrow retainer to ${vendor}`,
      });
      await addNotice({
        memberId: member.id,
        projectId: project.id,
        kind: "grace",
        title: "Project live — Stage 1 open, 30 days to first evidence",
        body: `${vendor} holds backer funds. Post your Stage 1 evidence in the project room before the due date and the stage verifies, doubling point value for the next round of backers.`,
        recoveryPath: `Miss the date and you get a ${GRACE_DAYS}-day grace period plus a written cure plan before anything is foreclosed. Ask for an extension in the room — inactivity is what triggers default, not difficulty.`,
        dueAt: daysFromNow(30),
      });

      if (member.role === "member") {
        await db.update(schema.members).set({ role: "creator" }).where(eq(schema.members.id, member.id));
      }

      return project;
    }),

  comment: base
    .input(
      z.object({
        memberId: z.number(),
        projectId: z.number(),
        body: z.string().min(2).max(1200),
        verdict: z.enum(["neutral", "try", "bye"]).default("neutral"),
      }),
    )
    .handler(async ({ input }) => {
      await getProject(input.projectId);
      const member = await getMember(input.memberId);
      const [comment] = await db
        .insert(schema.comments)
        .values({
          projectId: input.projectId,
          memberId: member.id,
          body: input.body,
          verdict: input.verdict,
        })
        .returning();
      await db
        .update(schema.members)
        .set({ clout: member.clout + 2 })
        .where(eq(schema.members.id, member.id));
      return comment;
    }),

  /** Creator posts evidence for the open milestone. */
  submitMilestone: base
    .input(z.object({ memberId: z.number(), milestoneId: z.number(), evidence: z.string().min(10).max(2000) }))
    .handler(async ({ input }) => {
      const [ms] = await db
        .select()
        .from(schema.milestones)
        .where(eq(schema.milestones.id, input.milestoneId));
      if (!ms) throw new ORPCError("NOT_FOUND", { message: "Milestone not found" });
      const project = await getProject(ms.projectId);
      if (project.creatorId !== input.memberId) {
        throw new ORPCError("FORBIDDEN", { message: "Only the project owner can submit evidence" });
      }
      await db
        .update(schema.milestones)
        .set({ status: "submitted", evidence: input.evidence })
        .where(eq(schema.milestones.id, ms.id));
      await db
        .update(schema.projects)
        .set({ lastActivityAt: new Date(), status: project.status === "default_notice" ? "live" : project.status })
        .where(eq(schema.projects.id, project.id));
      return { ok: true, message: "Evidence logged. Escrow reviewer notified (simulated)." };
    }),

  /** Creator cancels: 25% clawback, 75% of principal back to backers. */
  cancel: base
    .input(z.object({ memberId: z.number(), projectId: z.number(), reason: z.string().min(5).max(500) }))
    .handler(async ({ input }) => {
      const project = await getProject(input.projectId);
      if (project.creatorId !== input.memberId) {
        throw new ORPCError("FORBIDDEN", { message: "Only the project owner can cancel" });
      }
      if (["cancelled", "foreclosed", "redistributed"].includes(project.status)) {
        throw new ORPCError("BAD_REQUEST", { message: "Project is already closed out" });
      }

      const invs = await db
        .select()
        .from(schema.investments)
        .where(eq(schema.investments.projectId, project.id));

      let refunded = 0;
      let clawback = 0;
      for (const inv of invs) {
        const back = Math.round(inv.amountCents * (1 - CANCEL_CLAWBACK_RATE));
        const held = inv.amountCents - back;
        refunded += back;
        clawback += held;
        await creditWallet(inv.memberId, back);
        await db
          .update(schema.investments)
          .set({ escrowStatus: "refunded" })
          .where(eq(schema.investments.id, inv.id));
        await addLedger({
          kind: "refund",
          amountCents: back,
          memberId: inv.memberId,
          projectId: project.id,
          bucket: "member",
          note: "75% principal returned on creator cancellation",
        });
      }

      const houseCut = Math.round(clawback * 0.4);
      const featureFund = clawback - houseCut;
      if (clawback > 0) {
        await addLedger({
          kind: "clawback",
          amountCents: houseCut,
          projectId: project.id,
          bucket: "house",
          note: "House share of cancellation clawback",
        });
        await addLedger({
          kind: "feature_funding",
          amountCents: featureFund,
          projectId: project.id,
          bucket: "feature_fund",
          note: "Cancellation clawback routed to member-value features",
        });
      }

      await db
        .update(schema.projects)
        .set({ status: "cancelled", defaultReason: input.reason, escrowStatus: "released" })
        .where(eq(schema.projects.id, project.id));
      await addNotice({
        memberId: project.creatorId,
        projectId: project.id,
        kind: "cure_plan",
        title: "Cancellation settled — how to come back",
        body: `$${(refunded / 100).toFixed(2)} returned to backers, $${(clawback / 100).toFixed(2)} retained under the 25% clawback. Your trust score takes the hit, not your standing.`,
        recoveryPath:
          "Two approved clout tasks or one verified milestone on a new project restores your prior level. No permanent bans for cancelling honestly.",
      });

      return { refundedCents: refunded, clawbackCents: clawback, backers: invs.length };
    }),

  /** Projects the creator runs, with their milestones and open notices. */
  mine: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.creatorId, input.memberId))
      .orderBy(desc(schema.projects.createdAt));
    const ids = rows.map((r) => r.id);
    const ms = ids.length
      ? await db.select().from(schema.milestones).where(inArray(schema.milestones.projectId, ids))
      : [];
    const notices = await db
      .select()
      .from(schema.notices)
      .where(and(eq(schema.notices.memberId, input.memberId), eq(schema.notices.resolved, false)))
      .orderBy(desc(schema.notices.createdAt));
    return rows.map((p) => ({
      ...p,
      milestones: ms.filter((m) => m.projectId === p.id).sort((a, b) => a.stage - b.stage),
      notices: notices.filter((n) => n.projectId === p.id),
    }));
  }),
};
