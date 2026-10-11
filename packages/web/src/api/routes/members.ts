import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { base } from "../middleware/errors";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  LEVELS,
  ONGOING_UNLOCK_CENTS,
  levelConfig,
  scoreBand,
  trustFactors,
  weekKey,
} from "../lib/economy";
import { addLedger, addNotice, debitWallet, getMember, takeHouseFee } from "../lib/helpers";

const worldEnum = z.enum(["underground", "lab", "prestige"]);
const brandEnum = z.enum(["forge", "orbital", "sole", "hub"]);

async function memberStats(memberId: number) {
  const [draws, investments, tasks, notices, verified] = await Promise.all([
    db.select().from(schema.draws).where(eq(schema.draws.memberId, memberId)),
    db.select().from(schema.investments).where(eq(schema.investments.memberId, memberId)),
    db.select().from(schema.tasks).where(eq(schema.tasks.memberId, memberId)),
    db
      .select()
      .from(schema.notices)
      .where(and(eq(schema.notices.memberId, memberId), eq(schema.notices.resolved, false))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.milestones)
      .innerJoin(schema.projects, eq(schema.milestones.projectId, schema.projects.id))
      .where(and(eq(schema.projects.creatorId, memberId), eq(schema.milestones.status, "verified"))),
  ]);

  return {
    draws,
    investments,
    tasksApproved: tasks.filter((t) => t.status === "approved").length,
    openNotices: notices,
    defaults: notices.filter((n) => n.kind === "default_notice" || n.kind === "foreclosure").length,
    milestonesVerified: Number(verified[0]?.count ?? 0),
  };
}

export const members = {
  /** Create a passport. No password in this build — identity is a demo handle. */
  join: base
    .input(
      z.object({
        displayName: z.string().min(2).max(60),
        handle: z
          .string()
          .min(3)
          .max(24)
          .regex(/^[a-z0-9_]+$/, "lowercase letters, numbers and underscores only"),
        email: z.string().email(),
        world: worldEnum.default("underground"),
        homeBrand: brandEnum.default("forge"),
        track: z.enum(["backer", "creator", "both"]).default("both"),
        bio: z.string().max(280).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const existing = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.handle, input.handle));
      if (existing.length) {
        throw new ORPCError("CONFLICT", { message: "That handle is taken" });
      }
      const [member] = await db
        .insert(schema.members)
        .values({
          displayName: input.displayName,
          handle: input.handle,
          email: input.email,
          world: input.world,
          homeBrand: input.homeBrand,
          role: input.track === "backer" ? "member" : "creator",
          bio: input.bio ?? null,
        })
        .returning();
      await addNotice({
        memberId: member.id,
        kind: "grace",
        title: "Welcome — nothing here can bankrupt you",
        body: "Your starting balance is simulated club credit. Level 0 gives you three draws a week, a $10 cap per project, and an answer required before the next draw unlocks.",
        recoveryPath:
          "Complete the identity check whenever you like. Skipping it only limits Orbital Works and score lookups.",
      });
      return member;
    }),

  get: base.input(z.object({ memberId: z.number() })).handler(({ input }) => getMember(input.memberId)),

  byHandle: base.input(z.object({ handle: z.string() })).handler(async ({ input }) => {
    const [member] = await db
      .select()
      .from(schema.members)
      .where(eq(schema.members.handle, input.handle.toLowerCase()));
    if (!member) throw new ORPCError("NOT_FOUND", { message: "No member with that handle" });
    return member;
  }),

  list: base.handler(() =>
    db.select({
      id: schema.members.id,
      handle: schema.members.handle,
      displayName: schema.members.displayName,
      role: schema.members.role,
      level: schema.members.level,
      walletCents: schema.members.walletCents,
    }).from(schema.members).orderBy(desc(schema.members.clout)).limit(50),
  ),

  setWorld: base
    .input(z.object({ memberId: z.number(), world: worldEnum }))
    .handler(async ({ input }) => {
      await db
        .update(schema.members)
        .set({ world: input.world })
        .where(eq(schema.members.id, input.memberId));
      return getMember(input.memberId);
    }),

  /** Dashboard summary for the signed-in passport. */
  dashboard: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    const member = await getMember(input.memberId);
    const stats = await memberStats(member.id);
    const cfg = levelConfig(member.level);
    const wk = weekKey();
    const weekDraws = stats.draws.filter((d) => d.weekKey === wk);
    const pending = weekDraws.find((d) => d.decision === "pending");

    const positions = await db
      .select({
        investment: schema.investments,
        project: schema.projects,
      })
      .from(schema.investments)
      .innerJoin(schema.projects, eq(schema.investments.projectId, schema.projects.id))
      .where(eq(schema.investments.memberId, member.id))
      .orderBy(desc(schema.investments.createdAt));

    const investedCents = positions.reduce((s, p) => s + p.investment.amountCents, 0);
    const liveCents = positions
      .filter((p) => !["foreclosed", "cancelled", "redistributed"].includes(p.project.status))
      .reduce((s, p) => s + p.investment.amountCents, 0);

    return {
      member,
      level: cfg,
      nextLevel: LEVELS[member.level + 1] ?? null,
      week: {
        key: wk,
        used: weekDraws.length,
        allowance: cfg.drawsPerWeek,
        remaining: Math.max(0, cfg.drawsPerWeek - weekDraws.length),
        pendingProjectId: pending?.projectId ?? null,
      },
      portfolio: {
        positions: positions.slice(0, 25),
        count: positions.length,
        investedCents,
        liveCents,
        pointsEarned: positions.reduce((s, p) => s + p.investment.pointsAwarded, 0),
        equityBp: positions.reduce((s, p) => s + p.investment.equityBp, 0),
      },
      notices: stats.openNotices,
    };
  }),

  /** Private score with every factor spelled out. */
  scores: base
    .input(z.object({ memberId: z.number(), targetHandle: z.string().optional() }))
    .handler(async ({ input }) => {
      const viewer = await getMember(input.memberId);
      let target = viewer;
      if (input.targetHandle && input.targetHandle !== viewer.handle) {
        const [found] = await db
          .select()
          .from(schema.members)
          .where(eq(schema.members.handle, input.targetHandle.toLowerCase()));
        if (!found) throw new ORPCError("NOT_FOUND", { message: "No member with that handle" });
        const allowed = viewer.level >= 4 || viewer.kycStatus === "accredited" || viewer.role === "admin";
        if (!allowed) {
          throw new ORPCError("FORBIDDEN", {
            message:
              "Score lookups open at the Accredited Circle. Members can always see their own file.",
          });
        }
        target = found;
        logDecision("scores", "Permitted private lookup", { viewerId: viewer.id, targetId: found.id });
        await addNotice({ memberId: found.id, kind: "score_lookup", title: "Private score lookup", body: `@${viewer.handle} viewed your private standing file.`, recoveryPath: "In production you can request an access audit from the privacy desk." });
      }

      const stats = await memberStats(target.id);
      const ageDays = Math.max(
        0,
        Math.round((Date.now() - new Date(target.createdAt).getTime()) / 86400000),
      );
      const trust = trustFactors({
        decisionsMade: stats.draws.filter((d) => d.decision !== "pending").length,
        decisionsPending: stats.draws.filter((d) => d.decision === "pending").length,
        investments: stats.investments.length,
        tasksApproved: stats.tasksApproved,
        defaults: stats.defaults,
        milestonesVerified: stats.milestonesVerified,
        kycStatus: target.kycStatus,
        accountAgeDays: ageDays,
      });

      await db
        .update(schema.members)
        .set({ trustScore: trust.score })
        .where(eq(schema.members.id, target.id));

      return {
        self: target.id === viewer.id,
        handle: target.handle,
        displayName: target.displayName,
        trust: { ...trust, band: scoreBand(trust.score) },
        social: {
          score: target.socialScore,
          band: scoreBand(target.socialScore),
          factors: [
            { label: "Clout", detail: "Earned by marketing and diligence others acted on", points: target.clout, max: 2000 },
            { label: "Verdict weight", detail: "How often your try/bye call matched the outcome", points: Math.round(target.socialScore / 10), max: 100 },
          ],
        },
        visibility:
          "Scores are private. You see your own file in full. Accredited Circle members can look up a handle; every lookup is logged to that member.",
      };
    }),

  levelUp: base
    .input(z.object({ memberId: z.number(), method: z.enum(["fee", "points"]) }))
    .handler(async ({ input }) => {
      const member = await getMember(input.memberId);
      const next = LEVELS[member.level + 1];
      if (!next) throw new ORPCError("BAD_REQUEST", { message: "Top level already" });

      if (input.method === "points") {
        if (member.points < next.pointCost) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Needs ${next.pointCost} points, you hold ${member.points}`,
          });
        }
        await db
          .update(schema.members)
          .set({ points: member.points - next.pointCost, level: next.level })
          .where(eq(schema.members.id, member.id));
        await addLedger({
          kind: "level_up",
          amountCents: 0,
          memberId: member.id,
          bucket: "member",
          note: `${next.name} unlocked with ${next.pointCost} points`,
        });
      } else {
        await debitWallet(member.id, next.feeCents, `${next.name} unlock`);
        await db
          .update(schema.members)
          .set({ level: next.level })
          .where(eq(schema.members.id, member.id));
        await addLedger({
          kind: "level_up",
          amountCents: next.feeCents,
          memberId: member.id,
          bucket: "house",
          note: `${next.name} unlock fee`,
        });
        await takeHouseFee({
          amountCents: next.feeCents,
          feeCents: Math.round(next.feeCents * 0.1),
          memberId: member.id,
          note: `${next.name} unlock`,
        });
      }

      if (next.level >= 2) {
        await db
          .update(schema.members)
          .set({ ongoingAccess: true })
          .where(eq(schema.members.id, member.id));
      }
      return getMember(member.id);
    }),

  unlockOngoing: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    const member = await getMember(input.memberId);
    if (member.ongoingAccess) return member;
    await debitWallet(member.id, ONGOING_UNLOCK_CENTS, "ongoing round access");
    await db
      .update(schema.members)
      .set({ ongoingAccess: true })
      .where(eq(schema.members.id, member.id));
    await takeHouseFee({
      amountCents: ONGOING_UNLOCK_CENTS,
      feeCents: Math.round(ONGOING_UNLOCK_CENTS * 0.1),
      memberId: member.id,
      note: "Ongoing round access",
    });
    return getMember(member.id);
  }),

  /** Simulated KYC tiers — the real thing is a vendor handoff, see /compliance. */
  kyc: base
    .input(z.object({ memberId: z.number(), tier: z.enum(["verified", "accredited"]) }))
    .handler(async ({ input }) => {
      await db
        .update(schema.members)
        .set({ kycStatus: input.tier })
        .where(eq(schema.members.id, input.memberId));
      await addNotice({
        memberId: input.memberId,
        kind: "reinstatement",
        title: `Identity tier set to ${input.tier} (simulated)`,
        body: "In production this status is written by the KYC/AML vendor's webhook, not by the platform. Nothing here is a real identity check.",
        recoveryPath: "If a real check fails, you keep Level 0 access and can appeal with documents.",
      });
      return getMember(input.memberId);
    }),

  topUp: base
    .input(z.object({ memberId: z.number(), amountCents: z.number().min(100).max(100000) }))
    .handler(async ({ input }) => {
      const member = await getMember(input.memberId);
      await db
        .update(schema.members)
        .set({ walletCents: member.walletCents + input.amountCents })
        .where(eq(schema.members.id, member.id));
      await addLedger({
        kind: "investment",
        amountCents: input.amountCents,
        memberId: member.id,
        bucket: "member",
        note: "Simulated club credit top-up (no card charged)",
      });
      return getMember(member.id);
    }),

  leaderboard: base.handler(async () => {
    const rows = await db
      .select({
        id: schema.members.id,
        handle: schema.members.handle,
        displayName: schema.members.displayName,
        level: schema.members.level,
        clout: schema.members.clout,
        points: schema.members.points,
        homeBrand: schema.members.homeBrand,
      })
      .from(schema.members)
      .orderBy(desc(schema.members.clout))
      .limit(12);
    return rows;
  }),
};
