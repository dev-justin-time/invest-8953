import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { base } from "../middleware/errors";
import { db } from "../database";
import * as schema from "../database/schema";
import { GRACE_DAYS, HOUSE_RATE, RESERVE_RATE, daysFromNow } from "../lib/economy";
import { addLedger, addNotice, getMember, getProject, requireAdmin } from "../lib/helpers";

export const house = {
  /** The books, open to admins: take, reserve, redistribution pool, exposure. */
  ledger: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    await requireAdmin(input.memberId);

    const byBucket = await db
      .select({
        bucket: schema.ledger.bucket,
        total: sql<number>`sum(${schema.ledger.amountCents})`,
        count: sql<number>`count(*)`,
      })
      .from(schema.ledger)
      .groupBy(schema.ledger.bucket);

    const byKind = await db
      .select({
        kind: schema.ledger.kind,
        total: sql<number>`sum(${schema.ledger.amountCents})`,
        count: sql<number>`count(*)`,
      })
      .from(schema.ledger)
      .groupBy(schema.ledger.kind);

    const recent = await db
      .select()
      .from(schema.ledger)
      .orderBy(desc(schema.ledger.createdAt))
      .limit(40);

    const [memberAgg] = await db
      .select({
        members: sql<number>`count(*)`,
        points: sql<number>`sum(${schema.members.points})`,
        wallet: sql<number>`sum(${schema.members.walletCents})`,
      })
      .from(schema.members);

    const projectRows = await db.select().from(schema.projects);
    const bucket = (name: string) => Number(byBucket.find((b) => b.bucket === name)?.total ?? 0);

    return {
      rates: { houseRate: HOUSE_RATE, reserveRate: RESERVE_RATE },
      houseCents: bucket("house"),
      reserveCents: bucket("reserve"),
      featureFundCents: bucket("feature_fund"),
      escrowHeldCents: bucket("escrow"),
      byBucket: byBucket.map((b) => ({ ...b, total: Number(b.total ?? 0), count: Number(b.count) })),
      byKind: byKind.map((b) => ({ ...b, total: Number(b.total ?? 0), count: Number(b.count) })),
      recent,
      network: {
        memberCount: Number(memberAgg?.members ?? 0),
        pointsOutstanding: Number(memberAgg?.points ?? 0),
        walletFloatCents: Number(memberAgg?.wallet ?? 0),
        projects: projectRows.length,
        live: projectRows.filter((p) => p.status === "live").length,
        defaulting: projectRows.filter((p) => p.status === "default_notice").length,
        foreclosed: projectRows.filter((p) => ["foreclosed", "redistributed"].includes(p.status)).length,
      },
    };
  }),

  /** Projects gone quiet, with the accommodation ladder before any enforcement. */
  watchlist: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    await requireAdmin(input.memberId);
    const rows = await db
      .select({ project: schema.projects, creator: schema.members })
      .from(schema.projects)
      .innerJoin(schema.members, eq(schema.projects.creatorId, schema.members.id))
      .orderBy(schema.projects.lastActivityAt);

    return rows
      .filter((r) => ["live", "funded", "default_notice"].includes(r.project.status))
      .map((r) => {
        const idleDays = Math.round(
          (Date.now() - new Date(r.project.lastActivityAt).getTime()) / 86400000,
        );
        const stage = r.project.status === "default_notice"
          ? "default_notice"
          : idleDays >= 45
            ? "notice_due"
            : idleDays >= 21
              ? "grace_due"
              : "healthy";
        return {
          ...r.project,
          creatorHandle: r.creator.handle,
          creatorTrust: r.creator.trustScore,
          idleDays,
          escalation: stage,
          recommendation:
            stage === "healthy"
              ? "Leave alone."
              : stage === "grace_due"
                ? "Send a grace notice with a written cure plan. No penalty attaches yet."
                : stage === "notice_due"
                  ? "Issue a default notice. 21 days to cure, with the cure steps spelled out."
                  : "Cure window expired — foreclosure is available, and backers get equity, not a lecture.",
        };
      });
  }),

  /** Grace first, always. A notice is a help document with a deadline on it. */
  issueGrace: base
    .input(z.object({ memberId: z.number(), projectId: z.number(), reason: z.string().min(5).max(600) }))
    .handler(async ({ input }) => {
      await requireAdmin(input.memberId);
      const project = await getProject(input.projectId);
      await db
        .update(schema.projects)
        .set({ graceUntil: daysFromNow(GRACE_DAYS) })
        .where(eq(schema.projects.id, project.id));
      await addNotice({
        memberId: project.creatorId,
        projectId: project.id,
        kind: "grace",
        title: `Grace period opened — ${GRACE_DAYS} days, no penalty`,
        body: `${input.reason}\n\nNothing is held against you during a grace period. Backer funds stay in escrow and your score is untouched.`,
        recoveryPath:
          "Any one of these closes it: post milestone evidence, post a revised timeline your backers can vote on, or request a stage reset that returns unspent escrow and keeps your standing.",
        dueAt: daysFromNow(GRACE_DAYS),
      });
      return { ok: true, graceUntil: daysFromNow(GRACE_DAYS) };
    }),

  issueDefaultNotice: base
    .input(z.object({ memberId: z.number(), projectId: z.number(), reason: z.string().min(5).max(600) }))
    .handler(async ({ input }) => {
      await requireAdmin(input.memberId);
      const project = await getProject(input.projectId);
      const [priorGrace] = await db.select().from(schema.notices).where(and(eq(schema.notices.projectId, project.id), eq(schema.notices.kind, "grace"), eq(schema.notices.resolved, false))).orderBy(desc(schema.notices.createdAt)).limit(1);
      if (!priorGrace || !project.graceUntil || new Date(project.graceUntil).getTime() > Date.now() || project.status === "default_notice") {
        throw new ORPCError("BAD_REQUEST", { message: "Open grace first and let its accommodation window expire before a default notice." });
      }
      await db
        .update(schema.projects)
        .set({
          status: "default_notice",
          defaultReason: input.reason,
          graceUntil: daysFromNow(GRACE_DAYS),
        })
        .where(eq(schema.projects.id, project.id));
      await addNotice({
        memberId: project.creatorId,
        projectId: project.id,
        kind: "default_notice",
        title: `Notice of default — ${GRACE_DAYS} days to cure`,
        body: `Reason: ${input.reason}\n\nThis is a notice, not a judgment. Escrowed funds are frozen, not seized. Curing within the window erases the notice from your public record.`,
        recoveryPath:
          "Cure options, any one sufficient: (1) post the outstanding milestone evidence, (2) agree a revised schedule with two-thirds of backers by weight, (3) hand the project to a member operator from the Syndicate list and keep 40% of your equity, (4) voluntary wind-down returning escrow minus the 25% clawback.",
        dueAt: daysFromNow(GRACE_DAYS),
      });
      return { ok: true };
    }),

  cureNotice: base
    .input(z.object({ memberId: z.number(), noticeId: z.number(), resolution: z.string().min(5).max(600) }))
    .handler(async ({ input }) => {
      await requireAdmin(input.memberId);
      const [notice] = await db
        .select()
        .from(schema.notices)
        .where(eq(schema.notices.id, input.noticeId));
      if (!notice) throw new ORPCError("NOT_FOUND", { message: "Notice not found" });
      await db
        .update(schema.notices)
        .set({ resolved: true })
        .where(eq(schema.notices.id, notice.id));
      if (notice.projectId) {
        await db
          .update(schema.projects)
          .set({ status: "live", defaultReason: null, graceUntil: null, lastActivityAt: new Date() })
          .where(eq(schema.projects.id, notice.projectId));
      }
      await addNotice({
        memberId: notice.memberId,
        projectId: notice.projectId,
        kind: "reinstatement",
        title: "Cured — record cleared",
        body: input.resolution,
        recoveryPath: "No residual penalty. The default does not appear in your standing history.",
      });
      return { ok: true };
    }),

  /**
   * Foreclosure: only after grace + notice. Backer equity survives; the creator's
   * unearned slice becomes redistribution lots, and the value funds member features.
   */
  foreclose: base
    .input(z.object({ memberId: z.number(), projectId: z.number(), reason: z.string().min(5).max(600) }))
    .handler(async ({ input }) => {
      await requireAdmin(input.memberId);
      const project = await getProject(input.projectId);
      if (project.status !== "default_notice" || !project.graceUntil || new Date(project.graceUntil).getTime() > Date.now()) {
        throw new ORPCError("BAD_REQUEST", {
          message: "A project must sit under a default notice and an expired cure window first.",
        });
      }

      const creatorBp = Math.max(0, 10000 - project.equityAllocatedBp);
      const lotBp = Math.round(creatorBp * 0.6);
      const escrowRemaining = project.raisedCents;
      const featureShare = Math.round(escrowRemaining * 0.5);

      await db
        .update(schema.projects)
        .set({ status: "foreclosed", defaultReason: input.reason, escrowStatus: "released" })
        .where(eq(schema.projects.id, project.id));

      if (lotBp > 0) {
        await db.insert(schema.equityListings).values({
          projectId: project.id,
          sellerId: input.memberId,
          equityBp: lotBp,
          askCents: Math.max(500, Math.round(escrowRemaining * 0.2)),
          status: "foreclosed_lot",
        });
      }

      if (featureShare > 0) {
        await addLedger({
          kind: "redistribution",
          amountCents: escrowRemaining - featureShare,
          projectId: project.id,
          bucket: "member",
          note: "Residual escrow credited pro-rata to backers of the foreclosed project",
        });
        await addLedger({
          kind: "feature_funding",
          amountCents: featureShare,
          projectId: project.id,
          bucket: "feature_fund",
          note: "Failed asset value routed into member-value features",
        });

        const invs = await db
          .select()
          .from(schema.investments)
          .where(eq(schema.investments.projectId, project.id));
        const totalHeld = invs.reduce((s, i) => s + i.amountCents, 0) || 1;
        for (const inv of invs) {
          const share = Math.round(((escrowRemaining - featureShare) * inv.amountCents) / totalHeld);
          const [m] = await db.select().from(schema.members).where(eq(schema.members.id, inv.memberId));
          if (m) {
            await db
              .update(schema.members)
              .set({ walletCents: m.walletCents + share })
              .where(eq(schema.members.id, m.id));
          }
          await db
            .update(schema.investments)
            .set({ escrowStatus: "clawback_settled" })
            .where(eq(schema.investments.id, inv.id));
          await addNotice({
            memberId: inv.memberId,
            projectId: project.id,
            kind: "reserve_claim",
            title: `Foreclosure settled on ${project.title}`,
            body: `Your $${(inv.amountCents / 100).toFixed(2)} ticket returned $${(share / 100).toFixed(2)} of residual escrow. You keep ${(inv.equityBp / 100).toFixed(2)}% of the asset — equity is not cancelled by foreclosure.`,
            recoveryPath:
              "The foreclosure lot is on the Equity Book. If a member operator revives the project, your slice rides along at no extra cost.",
          });
        }
      }

      await addNotice({
        memberId: project.creatorId,
        projectId: project.id,
        kind: "foreclosure",
        title: "Project foreclosed — here is the way back",
        body: `Reason: ${input.reason}\n\nYou keep ${((creatorBp - lotBp) / 100).toFixed(2)}% of the asset. The other ${(lotBp / 100).toFixed(2)}% is now a redistribution lot on the Equity Book.`,
        recoveryPath:
          "Standing is restorable: two approved clout tasks or one verified milestone on any project lifts the flag. You can also buy your lot back off the Equity Book at the listed ask before another member does.",
      });

      return { lotBp, residualDistributedCents: escrowRemaining - featureShare, featureFundCents: featureShare };
    }),

  /** Where failed-asset money goes — features members voted for. */
  features: base.handler(async () => {
    const rows = await db.select().from(schema.features).orderBy(desc(schema.features.votes));
    const [fund] = await db
      .select({ total: sql<number>`sum(${schema.ledger.amountCents})` })
      .from(schema.ledger)
      .where(eq(schema.ledger.bucket, "feature_fund"));
    return { features: rows, fundCents: Number(fund?.total ?? 0) };
  }),

  voteFeature: base
    .input(z.object({ memberId: z.number(), featureId: z.number() }))
    .handler(async ({ input }) => {
      const [f] = await db.select().from(schema.features).where(eq(schema.features.id, input.featureId));
      if (!f) throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
      await getMember(input.memberId);
      const [already] = await db
        .select()
        .from(schema.featureVotes)
        .where(
          and(eq(schema.featureVotes.featureId, f.id), eq(schema.featureVotes.memberId, input.memberId)),
        );
      if (already) throw new ORPCError("CONFLICT", { message: "One vote per member per feature" });
      await db.insert(schema.featureVotes).values({ featureId: f.id, memberId: input.memberId });
      await db
        .update(schema.features)
        .set({ votes: f.votes + 1 })
        .where(eq(schema.features.id, f.id));
      return { votes: f.votes + 1 };
    }),

  notices: base.input(z.object({ memberId: z.number() })).handler(async ({ input }) => {
    await requireAdmin(input.memberId);
    const rows = await db
      .select({ notice: schema.notices, member: schema.members })
      .from(schema.notices)
      .innerJoin(schema.members, eq(schema.notices.memberId, schema.members.id))
      .where(eq(schema.notices.resolved, false))
      .orderBy(desc(schema.notices.createdAt))
      .limit(60);
    return rows.map((r) => ({ ...r.notice, handle: r.member.handle }));
  }),

  myNotices: base.input(z.object({ memberId: z.number() })).handler(({ input }) =>
    db
      .select()
      .from(schema.notices)
      .where(and(eq(schema.notices.memberId, input.memberId), eq(schema.notices.resolved, false)))
      .orderBy(desc(schema.notices.createdAt)),
  ),
};
