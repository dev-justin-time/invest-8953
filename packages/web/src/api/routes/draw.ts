import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { actorOf, memberProc, type Member } from "../middleware/auth";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { LEVELS, MAX_INVEST_CENTS, levelConfig, pointValueForStage, weekKey } from "../lib/economy";
import { audit, audited } from "../lib/services/audit";
import { idempotencyKey, once } from "../lib/services/idempotency";
import { isAccredited, placeTicket } from "../lib/services/tickets";
import { runTx, type Db } from "../lib/services/tx";

async function weekState(tx: Db, member: Member) {
  const cfg = levelConfig(member.level);
  const wk = weekKey();
  const rows = await tx
    .select()
    .from(schema.draws)
    .where(and(eq(schema.draws.memberId, member.id), eq(schema.draws.weekKey, wk)));
  const [pending] = await tx
    .select()
    .from(schema.draws)
    .where(and(eq(schema.draws.memberId, member.id), eq(schema.draws.decision, "pending")));
  return { cfg, wk, rows, pending: pending ?? null };
}

function nextResetLabel() {
  const now = new Date();
  const days = (8 - (now.getUTCDay() || 7)) % 7 || 7;
  return `in ${days} day${days === 1 ? "" : "s"} when the week rolls over (Monday 00:00 UTC)`;
}

export const draw = {
  /** What the signed-in member is looking at right now: one decision, or an empty slot. */
  current: memberProc.handler(async ({ context }) => {
    const member = context.member;
    const { cfg, wk, rows, pending } = await weekState(db, member);
    let project = null;
    if (pending) {
      const [row] = await db
        .select({ project: schema.projects, creator: schema.members })
        .from(schema.projects)
        .innerJoin(schema.members, eq(schema.projects.creatorId, schema.members.id))
        .where(eq(schema.projects.id, pending.projectId));
      if (row) project = { ...row.project, creatorHandle: row.creator.handle, creatorName: row.creator.displayName };
    }
    const history = await db.select().from(schema.draws).where(eq(schema.draws.memberId, member.id));
    return {
      week: { key: wk, used: rows.length, allowance: cfg.drawsPerWeek, remaining: Math.max(0, cfg.drawsPerWeek - rows.length) },
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

  /** Unlock the next unseen opportunity, if the rules allow it. */
  next: memberProc.handler(({ context }) =>
    audited(actorOf(context), "draw.next", undefined, () =>
      runTx("draw.next", async (tx) => {
        const [member] = await tx.select().from(schema.members).where(eq(schema.members.id, context.member.id));
        const { cfg, wk, rows, pending } = await weekState(tx, member);
        if (pending) throw new ORPCError("BAD_REQUEST", { message: "Answer the open draw first — yes or bye. That is the whole game." });
        if (rows.length >= cfg.drawsPerWeek) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Level ${cfg.level} ${cfg.name} draws ${cfg.drawsPerWeek} a week. Level up with points or a fee, earn clout on the task board, or come back ${nextResetLabel()}.`,
          });
        }
        const seen = new Set((await tx.select({ projectId: schema.draws.projectId }).from(schema.draws).where(eq(schema.draws.memberId, member.id))).map((s) => s.projectId));
        const pool = (await tx.select().from(schema.projects).where(eq(schema.projects.status, "live")))
          .filter((p) => p.creatorId !== member.id)
          .filter((p) => !seen.has(p.id))
          .filter((p) => (member.ongoingAccess || member.level >= 2 ? true : p.stage === 1))
          .filter((p) => (p.brand === "orbital" ? isAccredited(member) : true));
        if (!pool.length) {
          throw new ORPCError("NOT_FOUND", {
            message: "The pool is empty for you right now — every open round has already been drawn, is yours, or needs access you have not unlocked.",
          });
        }
        const picked = pool[Math.floor(Math.random() * pool.length)];
        logDecision("draw", "Unseen round selected", { memberId: member.id, projectId: picked.id, weekUsed: rows.length });
        const [row] = await tx.insert(schema.draws).values({ memberId: member.id, projectId: picked.id, weekKey: wk, decision: "pending" }).returning();
        await audit(tx, actorOf(context), { action: "draw.next", outcome: "accepted", targetType: "project", targetId: picked.id, summary: `Drew round ${rows.length + 1}/${cfg.drawsPerWeek} for ${wk}` });
        return { draw: row, projectId: picked.id };
      }),
    ),
  ),

  /** Yes with a ticket, or bye for good. The decision and the ticket commit together. */
  decide: memberProc
    .input(
      z.object({
        drawId: z.number().int(),
        decision: z.enum(["yes", "bye"]),
        amountCents: z.number().int().min(100).max(MAX_INVEST_CENTS).optional(),
        note: z.string().max(600).optional(),
        idempotencyKey,
      }),
    )
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "draw.decide", { type: "draw", id: input.drawId }, () =>
        once({ memberId: context.member.id, scope: "draw.decide", key, payload }, async (tx) => {
          const [claimed] = await tx
            .update(schema.draws)
            .set({ decision: input.decision, decidedAt: new Date() })
            .where(and(eq(schema.draws.id, input.drawId), eq(schema.draws.memberId, context.member.id), eq(schema.draws.decision, "pending")))
            .returning();
          if (!claimed) throw new ORPCError("BAD_REQUEST", { message: "That draw is not open for you. Answers are final." });
          logDecision("draw", "Final decision", { memberId: context.member.id, drawId: claimed.id, decision: input.decision });

          if (input.note) {
            await tx.insert(schema.comments).values({ projectId: claimed.projectId, memberId: context.member.id, body: input.note, verdict: input.decision === "yes" ? "try" : "bye" });
          }
          if (input.decision === "bye") {
            await tx.update(schema.members).set({ clout: sql`${schema.members.clout} + 1` }).where(eq(schema.members.id, context.member.id));
            await audit(tx, actorOf(context), { action: "draw.decide", outcome: "accepted", targetType: "project", targetId: claimed.projectId, summary: "Bye — round closed to this member" });
            return { decision: "bye" as const, message: "Logged. That round is closed to you permanently." };
          }
          const result = await placeTicket(tx, context.member, claimed.projectId, input.amountCents ?? MAX_INVEST_CENTS, "The Draw");
          await audit(tx, actorOf(context), { action: "draw.decide", outcome: "accepted", targetType: "project", targetId: claimed.projectId, summary: `Yes — ticket of ${input.amountCents ?? MAX_INVEST_CENTS} cents` });
          return { decision: "yes" as const, ...result };
        }),
      );
    }),

  /** Direct ticket from a project room (after a yes draw, or with ongoing access). */
  invest: memberProc
    .input(z.object({ projectId: z.number().int(), amountCents: z.number().int().min(100).max(MAX_INVEST_CENTS), idempotencyKey }))
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "draw.invest", { type: "project", id: input.projectId }, () =>
        once({ memberId: context.member.id, scope: "draw.invest", key, payload }, async (tx) => {
          const drawn = await tx
            .select()
            .from(schema.draws)
            .where(and(eq(schema.draws.memberId, context.member.id), eq(schema.draws.projectId, input.projectId)));
          if (drawn.some((d) => d.decision === "bye")) throw new ORPCError("FORBIDDEN", { message: "You said bye to this one. That call stands." });
          if (drawn.some((d) => d.decision === "pending")) throw new ORPCError("BAD_REQUEST", { message: "Answer this round in The Draw first." });
          const [member] = await tx.select().from(schema.members).where(eq(schema.members.id, context.member.id));
          const hasYes = drawn.some((d) => d.decision === "yes");
          if (!hasYes && !member.ongoingAccess && member.level < 2) {
            throw new ORPCError("FORBIDDEN", { message: "Rounds reach you through The Draw at Level 0 and 1. Unlock direct access for $5 or reach Operator." });
          }
          const result = await placeTicket(tx, member, input.projectId, input.amountCents, "Project room");
          await audit(tx, actorOf(context), { action: "draw.invest", outcome: "accepted", targetType: "project", targetId: input.projectId, summary: `Direct ticket of ${input.amountCents} cents` });
          return result;
        }),
      );
    }),
};
