import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { base } from "../middleware/errors";
import { db } from "../database/client";
import * as schema from "../database/schema";
import {
  LEVELS,
  MAX_INVEST_CENTS,
  equityBpForTicket,
  houseFeeCents,
  levelConfig,
  pointValueForStage,
  weekKey,
} from "../lib/economy";
import { addLedger, debitWallet, getMember, getProject, takeHouseFee } from "../lib/helpers";

async function weekState(memberId: number) {
  const member = await getMember(memberId);
  const cfg = levelConfig(member.level);
  const wk = weekKey();
  const rows = await db
    .select()
    .from(schema.draws)
    .where(and(eq(schema.draws.memberId, memberId), eq(schema.draws.weekKey, wk)));
  const pending = rows.find((r) => r.decision === "pending") ?? null;
  return { member, cfg, wk, rows, pending };
}

async function placeTicket(args: {
  memberId: number;
  projectId: number;
  amountCents: number;
  source: string;
}) {
  const member = await getMember(args.memberId);
  const project = await getProject(args.projectId);

  if (project.status !== "live" && project.status !== "funded") {
    throw new ORPCError("BAD_REQUEST", { message: "This round is not taking tickets" });
  }
  if (project.creatorId === member.id) {
    throw new ORPCError("BAD_REQUEST", { message: "You cannot back your own project" });
  }
  if (project.brand === "orbital" && member.kycStatus !== "accredited" && member.level < 4 && member.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Orbital Works backing requires accredited status." });
  }
  if (project.stage > 1 && !member.ongoingAccess && member.level < 2) {
    throw new ORPCError("FORBIDDEN", {
      message:
        "Level 0 and 1 back new rounds only. Unlock ongoing rounds for $5, or reach Operator with points.",
    });
  }
  if (args.amountCents > MAX_INVEST_CENTS) {
    throw new ORPCError("BAD_REQUEST", { message: "The $10 ceiling holds at every stage" });
  }

  const existing = await db
    .select()
    .from(schema.investments)
    .where(
      and(eq(schema.investments.memberId, member.id), eq(schema.investments.projectId, project.id)),
    );
  const already = existing.reduce((s, e) => s + e.amountCents, 0);
  logDecision("tickets", "Ceiling checked", { memberId: member.id, projectId: project.id, already, requested: args.amountCents });
  if (already + args.amountCents > MAX_INVEST_CENTS) {
    throw new ORPCError("BAD_REQUEST", {
      message: `You already hold $${(already / 100).toFixed(2)} here. The per-project ceiling is $10.`,
    });
  }

  await debitWallet(member.id, args.amountCents, "ticket");

  const fee = houseFeeCents(args.amountCents);
  const escrowed = args.amountCents - fee;
  const points = Math.round(pointValueForStage(project.stage) * (args.amountCents / MAX_INVEST_CENTS));
  const equityBp = equityBpForTicket(escrowed, project.capitalGoalCents, project.equityOfferedBp);

  const [investment] = await db
    .insert(schema.investments)
    .values({
      projectId: project.id,
      memberId: member.id,
      amountCents: args.amountCents,
      pointsAwarded: points,
      equityBp,
      stage: project.stage,
      houseFeeCents: fee,
      escrowStatus: "held",
    })
    .returning();

  await db
    .update(schema.projects)
    .set({
      raisedCents: project.raisedCents + escrowed,
      backerCount: existing.length ? project.backerCount : project.backerCount + 1,
      equityAllocatedBp: project.equityAllocatedBp + equityBp,
      lastActivityAt: new Date(),
    })
    .where(eq(schema.projects.id, project.id));

  await db
    .update(schema.members)
    .set({ points: member.points + points, clout: member.clout + 3 })
    .where(eq(schema.members.id, member.id));

  await addLedger({
    kind: "investment",
    amountCents: escrowed,
    memberId: member.id,
    projectId: project.id,
    bucket: "escrow",
    note: `Ticket escrowed with ${project.escrowVendor ?? "assigned escrow agent"} (${args.source})`,
  });
  await takeHouseFee({
    amountCents: args.amountCents,
    feeCents: fee,
    memberId: member.id,
    projectId: project.id,
    note: "Ticket",
  });

  return {
    investment,
    pointsAwarded: points,
    equityBp,
    escrowedCents: escrowed,
    houseFeeCents: fee,
  };
}

export const draw = {
  /** What the member is looking at right now: one decision, or an empty slot. */
  current: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    const { member, cfg, wk, rows, pending } = await weekState(input.memberId);
    let project = null;
    if (pending) {
      const p = await getProject(pending.projectId);
      const creator = await getMember(p.creatorId);
      project = { ...p, creatorHandle: creator.handle, creatorName: creator.displayName };
    }
    const history = await db.select().from(schema.draws).where(eq(schema.draws.memberId, member.id));
    return {
      week: {
        key: wk,
        used: rows.length,
        allowance: cfg.drawsPerWeek,
        remaining: Math.max(0, cfg.drawsPerWeek - rows.length),
      },
      level: cfg,
      nextLevel: LEVELS[member.level + 1] ?? null,
      pending,
      project,
      pointValue: project ? pointValueForStage(project.stage) : null,
      lifetime: {
        drawn: history.length,
        backed: history.filter((h) => h.decision === "yes").length,
        passed: history.filter((h) => h.decision === "bye").length,
      },
      rule: "One open decision at a time. Say yes or bye — a bye is final and the next draw unlocks the moment you answer.",
    };
  }),

  /** Unlock the next opportunity, if the rules allow it. */
  next: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    const { member, cfg, wk, rows, pending } = await weekState(input.memberId);
    if (pending) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Answer the open draw first — yes or bye. That is the whole game.",
      });
    }
    if (rows.length >= cfg.drawsPerWeek) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Level ${cfg.level} ${cfg.name} draws ${cfg.drawsPerWeek} a week. Level up with points or a fee, earn clout on the task board, or come back ${nextResetLabel()}.`,
      });
    }

    const seen = await db.select().from(schema.draws).where(eq(schema.draws.memberId, member.id));
    const seenIds = new Set(seen.map((s) => s.projectId));

    const pool = (await db.select().from(schema.projects).where(eq(schema.projects.status, "live")))
      .filter((p) => p.creatorId !== member.id)
      .filter((p) => !seenIds.has(p.id))
      .filter((p) => (member.ongoingAccess ? true : p.stage === 1))
      .filter((p) => (p.brand === "orbital" ? member.kycStatus === "accredited" || member.level >= 4 || member.role === "admin" : true));

    if (!pool.length) {
      throw new ORPCError("NOT_FOUND", {
        message:
          "The pool is empty for you right now — every open round has already been drawn or is yours. New pitches land daily.",
      });
    }

    const picked = pool[Math.floor(Math.random() * pool.length)];
    logDecision("draw", "Unseen round selected", { memberId: member.id, projectId: picked.id, weekUsed: rows.length });
    const [row] = await db
      .insert(schema.draws)
      .values({ memberId: member.id, projectId: picked.id, weekKey: wk, decision: "pending" })
      .returning();
    return { draw: row, projectId: picked.id };
  }),

  /** Yes with a ticket, or bye for good. */
  decide: base
    .input(
      z.object({
        memberId: z.number(),
        drawId: z.number(),
        decision: z.enum(["yes", "bye"]),
        amountCents: z.number().min(100).max(MAX_INVEST_CENTS).optional(),
        note: z.string().max(600).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.select().from(schema.draws).where(eq(schema.draws.id, input.drawId));
      if (!row || row.memberId !== input.memberId) {
        throw new ORPCError("NOT_FOUND", { message: "Draw not found" });
      }
      if (row.decision !== "pending") {
        throw new ORPCError("BAD_REQUEST", { message: "Already answered. No going backward." });
      }

      logDecision("draw", "Final decision", { memberId: input.memberId, drawId: row.id, decision: input.decision });
      if (input.decision === "bye") {
        await db
          .update(schema.draws)
          .set({ decision: "bye", decidedAt: new Date() })
          .where(eq(schema.draws.id, row.id));
        if (input.note) {
          await db.insert(schema.comments).values({
            projectId: row.projectId,
            memberId: input.memberId,
            body: input.note,
            verdict: "bye",
          });
        }
        const member = await getMember(input.memberId);
        await db
          .update(schema.members)
          .set({ clout: member.clout + 1 })
          .where(eq(schema.members.id, member.id));
        return { decision: "bye" as const, message: "Logged. That round is closed to you permanently." };
      }

      const amount = input.amountCents ?? MAX_INVEST_CENTS;
      const result = await placeTicket({
        memberId: input.memberId,
        projectId: row.projectId,
        amountCents: amount,
        source: "The Draw",
      });
      await db
        .update(schema.draws)
        .set({ decision: "yes", decidedAt: new Date() })
        .where(eq(schema.draws.id, row.id));
      if (input.note) {
        await db.insert(schema.comments).values({
          projectId: row.projectId,
          memberId: input.memberId,
          body: input.note,
          verdict: "try",
        });
      }
      return { decision: "yes" as const, ...result };
    }),

  /** Direct ticket from a project room (Operator and up, or after a yes draw). */
  invest: base
    .input(
      z.object({
        memberId: z.number(),
        projectId: z.number(),
        amountCents: z.number().min(100).max(MAX_INVEST_CENTS),
      }),
    )
    .handler(async ({ input }) => {
      const member = await getMember(input.memberId);
      const drawn = await db
        .select()
        .from(schema.draws)
        .where(
          and(eq(schema.draws.memberId, member.id), eq(schema.draws.projectId, input.projectId)),
        );
      const hasYes = drawn.some((d) => d.decision === "yes");
      if (!hasYes && !member.ongoingAccess) {
        throw new ORPCError("FORBIDDEN", {
          message:
            "Rounds reach you through The Draw at Level 0 and 1. Unlock direct access for $5 or reach Operator.",
        });
      }
      if (drawn.some((d) => d.decision === "bye")) {
        throw new ORPCError("FORBIDDEN", { message: "You said bye to this one. That call stands." });
      }
      return placeTicket({
        memberId: input.memberId,
        projectId: input.projectId,
        amountCents: input.amountCents,
        source: "Project room",
      });
    }),
};

function nextResetLabel() {
  const now = new Date();
  const days = (8 - (now.getUTCDay() || 7)) % 7 || 7;
  return `in ${days} day${days === 1 ? "" : "s"} when the week rolls over (Monday 00:00 UTC)`;
}
