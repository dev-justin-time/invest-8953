import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { base } from "../middleware/errors";
import { db } from "../database";
import * as schema from "../database/schema";
import { addLedger, getMember } from "../lib/helpers";

/** Task board: the non-cash path to level up. Marketing a project you back pays most. */
export const TASK_TYPES = [
  {
    kind: "marketing",
    title: "Market a project you back",
    detail: "Post a truthful piece about a project to a real audience and log the link. Claims must match the project room — inflated claims are rejected and cost clout.",
    points: 60,
    clout: 25,
  },
  {
    kind: "diligence",
    title: "Write a diligence note",
    detail: "300+ words on a live pitch: what would have to be true, what would kill it, what evidence would settle it. Published in the project room under your handle.",
    points: 45,
    clout: 30,
  },
  {
    kind: "referral",
    title: "Bring a creator or backer",
    detail: "Your handle is credited when they complete a passport and their first decision.",
    points: 80,
    clout: 20,
  },
  {
    kind: "moderation",
    title: "Flag a rule break with evidence",
    detail: "Illegal content, unverifiable claims, or an unlicensed securities pitch. Confirmed flags pay; bad-faith flags cost clout.",
    points: 35,
    clout: 40,
  },
  {
    kind: "translation",
    title: "Translate a project room",
    detail: "Full translation of a pitch and its milestones into another language, reviewed by one other member.",
    points: 70,
    clout: 15,
  },
] as const;

export const clout = {
  board: base.handler(() => TASK_TYPES),

  claim: base
    .input(
      z.object({
        memberId: z.number(),
        kind: z.enum(["marketing", "diligence", "referral", "moderation", "translation"]),
        projectId: z.number().optional(),
        title: z.string().min(3).max(140),
      }),
    )
    .handler(async ({ input }) => {
      await getMember(input.memberId);
      const spec = TASK_TYPES.find((t) => t.kind === input.kind)!;
      const [task] = await db
        .insert(schema.tasks)
        .values({
          memberId: input.memberId,
          projectId: input.projectId ?? null,
          kind: input.kind,
          title: input.title || spec.title,
          status: "claimed",
        })
        .returning();
      return task;
    }),

  submit: base
    .input(z.object({ memberId: z.number(), taskId: z.number(), proof: z.string().min(10).max(2000) }))
    .handler(async ({ input }) => {
      const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, input.taskId));
      if (!task || task.memberId !== input.memberId) {
        throw new ORPCError("NOT_FOUND", { message: "Task not found" });
      }
      if (task.status !== "claimed") {
        throw new ORPCError("CONFLICT", { message: "This task has already been submitted. Rewards are issued once." });
      }
      const spec = TASK_TYPES.find((t) => t.kind === task.kind)!;
      const member = await getMember(input.memberId);

      // Auto-approved in this build; production routes to peer review by two Operators.
      await db
        .update(schema.tasks)
        .set({
          proof: input.proof,
          status: "approved",
          pointsAwarded: spec.points,
          cloutAwarded: spec.clout,
        })
        .where(eq(schema.tasks.id, task.id));
      await db
        .update(schema.members)
        .set({
          points: member.points + spec.points,
          clout: member.clout + spec.clout,
          socialScore: Math.min(1000, member.socialScore + 8),
        })
        .where(eq(schema.members.id, member.id));
      await addLedger({
        kind: "task_reward",
        amountCents: 0,
        memberId: member.id,
        projectId: task.projectId,
        bucket: "member",
        note: `${spec.title}: +${spec.points} points, +${spec.clout} clout`,
      });

      return {
        pointsAwarded: spec.points,
        cloutAwarded: spec.clout,
        note: "Approved automatically in this build. In production two Operators review before points land.",
      };
    }),

  mine: base.input(z.object({ memberId: z.number() })).handler(({ input }) =>
    db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.memberId, input.memberId))
      .orderBy(desc(schema.tasks.createdAt)),
  ),
};

/** Hub governance: one member one vote at the base, weighted by clout above it. */
export const governance = {
  proposals: base.handler(() =>
    db.select().from(schema.proposals).orderBy(desc(schema.proposals.createdAt)),
  ),

  propose: base
    .input(
      z.object({
        memberId: z.number(),
        title: z.string().min(6).max(140),
        body: z.string().min(40).max(4000),
      }),
    )
    .handler(async ({ input }) => {
      const member = await getMember(input.memberId);
      if (member.level < 1) {
        throw new ORPCError("FORBIDDEN", {
          message: "Proposals open at Associate. Two approved tasks gets you there without paying.",
        });
      }
      const [p] = await db
        .insert(schema.proposals)
        .values({
          title: input.title,
          body: input.body,
          closesAt: new Date(Date.now() + 14 * 86400000),
        })
        .returning();
      return p;
    }),

  vote: base
    .input(
      z.object({
        memberId: z.number(),
        proposalId: z.number(),
        choice: z.enum(["yes", "no"]),
      }),
    )
    .handler(async ({ input }) => {
      const member = await getMember(input.memberId);
      const existing = await db
        .select()
        .from(schema.votes)
        .where(eq(schema.votes.proposalId, input.proposalId));
      if (existing.some((v) => v.memberId === member.id)) {
        throw new ORPCError("BAD_REQUEST", { message: "You already voted on this one" });
      }
      const [proposal] = await db
        .select()
        .from(schema.proposals)
        .where(eq(schema.proposals.id, input.proposalId));
      if (!proposal) throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
      if (proposal.status !== "open" || (proposal.closesAt ? new Date(proposal.closesAt).getTime() : 0) < Date.now()) {
        throw new ORPCError("CONFLICT", { message: "Voting is closed for this proposal." });
      }

      // Weight: 1 base + sqrt(clout) — quadratic dampening so clout tilts, never dictates.
      const weight = 1 + Math.floor(Math.sqrt(member.clout));
      await db.insert(schema.votes).values({
        proposalId: proposal.id,
        memberId: member.id,
        choice: input.choice,
        weight,
      });
      await db
        .update(schema.proposals)
        .set({
          yesWeight: proposal.yesWeight + (input.choice === "yes" ? weight : 0),
          noWeight: proposal.noWeight + (input.choice === "no" ? weight : 0),
        })
        .where(eq(schema.proposals.id, proposal.id));
      return { weight, method: "1 vote + floor(sqrt(clout)). Quadratic dampening keeps whales from owning outcomes." };
    }),

  /** Mutual Cover Reserve: what actually backs the "one brand falls, members are covered" claim. */
  reserve: base.handler(async () => {
    const [reserve] = await db
      .select({ total: sql<number>`sum(${schema.ledger.amountCents})` })
      .from(schema.ledger)
      .where(eq(schema.ledger.bucket, "reserve"));
    const [exposure] = await db
      .select({ total: sql<number>`sum(${schema.ledger.amountCents})` })
      .from(schema.ledger)
      .where(eq(schema.ledger.bucket, "escrow"));

    const reserveCents = Number(reserve?.total ?? 0);
    const exposureCents = Number(exposure?.total ?? 0);
    const coverage = exposureCents > 0 ? reserveCents / exposureCents : 0;

    return {
      reserveCents,
      exposureCents,
      coverageRatio: coverage,
      target: 0.25,
      honest:
        coverage >= 0.25
          ? "Reserve currently covers a quarter of escrowed member capital. That is the target, not a guarantee — a total loss across every brand at once exceeds it."
          : "Reserve is below the 25% target. Until it clears the target, treat cover as partial and size tickets accordingly.",
      mechanics: [
        "25% of every house fee is parked in the Reserve before the house takes anything.",
        "Each brand is a separate legal entity; the Reserve sits at the Hub and is not an asset of any operating brand.",
        "If a brand is halted, Reserve funds are released by member vote to make that brand's backers whole, pro-rata, up to the coverage ratio.",
        "The Reserve never funds projects and never pays the house.",
      ],
    };
  }),
};
