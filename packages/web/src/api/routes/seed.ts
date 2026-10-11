import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { base } from "../middleware/errors";
import { db } from "../database";
import * as schema from "../database/schema";
import { runDistribution } from "./payouts";
import { ESCROW_FEE_CENTS, daysFromNow, pitchFeeCents, pointValueForStage } from "../lib/economy";

type RiskTier = "low" | "medium" | "high";

const DEMO_MEMBERS = [
  {
    handle: "house",
    displayName: "House Desk",
    email: "desk@kinship.club",
    role: "admin",
    level: 4,
    points: 0,
    clout: 0,
    walletCents: 500000,
    kycStatus: "accredited",
    world: "prestige",
    homeBrand: "hub",
    bio: "The operator account. Sees the books, issues notices, forecloses only after grace and a cure window.",
  },
  {
    handle: "mara_k",
    displayName: "Mara Kessler",
    email: "mara@example.com",
    role: "creator",
    level: 3,
    points: 1840,
    clout: 620,
    walletCents: 64000,
    kycStatus: "accredited",
    world: "lab",
    homeBrand: "orbital",
    bio: "Materials engineer. Ran two regolith sintering pilots before bringing the third here.",
  },
  {
    handle: "dee",
    displayName: "Dee Okonkwo",
    email: "dee@example.com",
    role: "creator",
    level: 2,
    points: 910,
    clout: 410,
    walletCents: 38000,
    kycStatus: "verified",
    world: "underground",
    homeBrand: "sole",
    bio: "Built a worn-apparel label to $14k/mo on someone else's platform. Wants the storefront and the IP in her own name.",
  },
  {
    handle: "vex",
    displayName: "Vex Ruiz",
    email: "vex@example.com",
    role: "creator",
    level: 1,
    points: 300,
    clout: 180,
    walletCents: 29000,
    kycStatus: "verified",
    world: "underground",
    homeBrand: "forge",
    bio: "Hardware tinkerer. Three failed pitches, one verified stage 3. Says the failures taught more.",
  },
  {
    handle: "nkem",
    displayName: "Nkem Adeyemi",
    email: "nkem@example.com",
    role: "member",
    level: 2,
    points: 640,
    clout: 295,
    walletCents: 41000,
    kycStatus: "verified",
    world: "lab",
    homeBrand: "forge",
    bio: "Reads every diligence note before drawing. Has never left a draw pending.",
  },
  {
    handle: "sol",
    displayName: "Sol Bergman",
    email: "sol@example.com",
    role: "creator",
    level: 2,
    points: 520,
    clout: 240,
    walletCents: 33000,
    kycStatus: "verified",
    world: "prestige",
    homeBrand: "forge",
    bio: "Ex-restaurant operator. Thinks milestone gates are the only honest part of early funding.",
  },
  {
    handle: "juno",
    displayName: "Juno Park",
    email: "juno@example.com",
    role: "member",
    level: 1,
    points: 210,
    clout: 130,
    walletCents: 25000,
    kycStatus: "none",
    world: "underground",
    homeBrand: "sole",
    bio: "Here for the task board. Marketing pays better than the draws at Level 1.",
  },
] as const;

type DemoProject = {
  creator: string;
  title: string;
  tagline: string;
  description: string;
  brand: "forge" | "orbital" | "sole";
  category: string;
  riskTier: RiskTier;
  capitalGoalCents: number;
  pitchFormat: "video" | "deck" | "drawing" | "prototype" | "writeup";
  equityOfferedBp: number;
  stage: number;
  status?: string;
  escrowVendor: string;
  idleDays?: number;
};

const DEMO_PROJECTS: DemoProject[] = [
  {
    creator: "mara_k",
    title: "Regolith Sinter Brick",
    tagline: "Press lunar-analogue dust into load-bearing brick with no binder and no water.",
    description:
      "We run a 14kW solar-concentrator sinter on JSC-1A lunar simulant and press 180mm modular brick. Two pilots done: the first cracked under thermal cycling, the second held 41 cycles at 78% of target compressive strength. This round funds a vacuum-chamber run to prove the process survives the environment it is actually for, plus a third-party materials lab test we do not control. What would kill it: if vacuum sintering collapses porosity control, the brick fails and this ends at stage 2. We will publish that result either way.",
    brand: "orbital",
    category: "space",
    riskTier: "high",
    capitalGoalCents: 1800000,
    pitchFormat: "deck",
    equityOfferedBp: 1200,
    stage: 2,
    escrowVendor: "Harbor & Vale Escrow (Wilmington, DE)",
    idleDays: 3,
  },
  {
    creator: "dee",
    title: "Sole Society — Anchor Label",
    tagline: "A worn-apparel label with its own storefront, its own IP, and its own payment rails.",
    description:
      "Fourteen thousand a month in verified sales on a third-party platform, screenshots and processor statements in escrow. The platform keeps 20% and owns the customer list. This round funds a self-hosted storefront, age and consent verification through a third-party vendor, trademark filing on the label name, and 90 days of high-risk processing reserve. Content stays on established platforms in phase 1 — this brand does the brand, the storefront, the IP and the payments, nothing else. Every law respected, no moral commentary from the platform. What would kill it: if a high-risk processor declines the category outright, the storefront cannot take card payments and the model reverts to the third-party platform.",
    brand: "sole",
    category: "worn_apparel",
    riskTier: "medium",
    capitalGoalCents: 850000,
    pitchFormat: "video",
    equityOfferedBp: 1500,
    stage: 1,
    escrowVendor: "Coastline Settlement Group (Tampa, FL)",
    idleDays: 1,
  },
  {
    creator: "vex",
    title: "Bench Pull — Open Torque Rig",
    tagline: "A $300 open-source dynamometer for small electric motors, shipped as a kit.",
    description:
      "Commercial small-motor dynos start at $4,000 and lock their data behind proprietary software. Our rig hits 0-8Nm at ±1.5% against a calibrated reference, logs to CSV, and the plans are CERN-OHL. 62 people on the waitlist from two maker forums, 11 paid deposits. This round funds a 50-unit production run, a calibration jig, and the accuracy certification we will publish. What would kill it: if the strain-gauge supply chain moves above $40 a unit, the $300 price does not survive and the kit becomes a $450 product with a much smaller waitlist.",
    brand: "forge",
    category: "hardware",
    riskTier: "low",
    capitalGoalCents: 1000000,
    pitchFormat: "prototype",
    equityOfferedBp: 1000,
    stage: 1,
    escrowVendor: "Meridian Fiduciary (Austin, TX)",
    idleDays: 2,
  },
  {
    creator: "sol",
    title: "Second Shift Kitchen",
    tagline: "Idle restaurant kitchens rented by the hour to licensed food businesses, 10pm to 6am.",
    description:
      "Restaurants sit dark two-thirds of the day while licensed caterers and packaged-food makers pay $28/hr for commissary space. We broker the hours, handle the insurance rider and the health-department paperwork, and take 18%. Four restaurants signed letters of intent covering 96 hours a week. This round funds the insurance program, the booking system, and the first city's permit work. What would kill it: a single health-code violation traced to a shared kitchen can close the host restaurant, and if insurers will not write the rider at a workable premium there is no business here.",
    brand: "forge",
    category: "service",
    riskTier: "low",
    capitalGoalCents: 1200000,
    pitchFormat: "writeup",
    equityOfferedBp: 900,
    stage: 3,
    escrowVendor: "Northbridge Escrow Co. (Chicago, IL)",
    idleDays: 5,
  },
  {
    creator: "mara_k",
    title: "Tailings Rare-Earth Scavenge",
    tagline: "Pull neodymium and dysprosium out of abandoned mine tailings with bioleaching.",
    description:
      "Old tailings piles hold rare-earth concentrations that were uneconomic at 1970s prices and are not now. We use an acidophilic bacterial consortium to leach at ambient temperature, avoiding the acid-roast step that makes conventional processing filthy and permit-hostile. Bench recovery: 34% of contained Nd over 21 days. This round funds a one-tonne pilot on a permitted site in Missouri with an independent assay. What would kill it: leach kinetics that do not scale out of the beaker, or a state permit regime that treats the process as new mining rather than remediation.",
    brand: "orbital",
    category: "deep_tech",
    riskTier: "high",
    capitalGoalCents: 2400000,
    pitchFormat: "deck",
    equityOfferedBp: 1400,
    stage: 1,
    escrowVendor: "Sierra Trust Services (Reno, NV)",
    idleDays: 4,
  },
  {
    creator: "juno",
    title: "Room Tone",
    tagline: "Paid licensing marketplace for field recordings, split 85/15 to the recordist.",
    description:
      "Sound libraries pay recordists a one-time fee of $50-200 and license the same asset for a decade. Room Tone licenses per-use, pays 85% to the recordist forever, and publishes the ledger so recordists can audit it. 340 recordings from 22 contributors already committed. This round funds the licensing engine, the audit ledger, and legal review of the contributor agreement — which the IP Desk drafts and an outside practitioner signs off. What would kill it: the sound-library market is small and stubbornly cheap; if per-use pricing does not clear what the flat-fee libraries pay, contributors go back.",
    brand: "forge",
    category: "media",
    riskTier: "low",
    capitalGoalCents: 600000,
    pitchFormat: "writeup",
    equityOfferedBp: 1100,
    stage: 1,
    escrowVendor: "Meridian Fiduciary (Austin, TX)",
    idleDays: 1,
  },
  {
    creator: "dee",
    title: "Consent Ledger",
    tagline: "Per-asset model release and consent records, held by a third-party custodian.",
    description:
      "Creator commerce in adult-adjacent categories lives or dies on records: who consented, to what, when, verified how. Platforms hold those records badly and creators cannot take them along when they leave. Consent Ledger issues a signed, timestamped release per asset, stores it with an independent records custodian, and gives the creator a portable export. Built for 18 U.S.C. 2257-style obligations without the platform ever holding the content. What would kill it: if custodians will not take the liability at a price creators can pay, this is a feature inside someone else's platform rather than a business.",
    brand: "sole",
    category: "service",
    riskTier: "medium",
    capitalGoalCents: 700000,
    pitchFormat: "deck",
    equityOfferedBp: 1300,
    stage: 1,
    escrowVendor: "Harbor & Vale Escrow (Wilmington, DE)",
    idleDays: 2,
  },
  {
    creator: "vex",
    title: "Coldframe",
    tagline: "A passive-cooled server closet for rural clinics with unreliable grid power.",
    description:
      "Clinics running on-premise records systems lose hardware to heat during outages when the AC drops but the UPS keeps the servers running. Coldframe is a phase-change thermal buffer sized to ride out a four-hour outage without active cooling. Two prototypes installed, both held under 42C through simulated outages. This round funds a 20-unit field trial with instrumented logging. What would kill it: at 20 units the phase-change material cost dominates and the unit price lands near a small generator, which clinics already understand how to buy.",
    brand: "forge",
    category: "hardware",
    riskTier: "medium",
    capitalGoalCents: 1500000,
    pitchFormat: "drawing",
    equityOfferedBp: 1000,
    stage: 1,
    status: "default_notice",
    escrowVendor: "Northbridge Escrow Co. (Chicago, IL)",
    idleDays: 58,
  },
];

const MILESTONE_TEMPLATES = [
  {
    title: "Stage 1 — Proof it exists",
    requirement: "Working artifact, footage, or signed letter of intent posted to the project room.",
  },
  {
    title: "Stage 2 — Proof someone wants it",
    requirement: "First paying customer, pre-order, or grant, with receipts in escrow.",
  },
  {
    title: "Stage 3 — Proof it repeats",
    requirement:
      "Three consecutive months of revenue or a filed IP asset with an examiner number.",
  },
  {
    title: "Stage 4 — Proof it scales",
    requirement: "Unit economics sheet plus a fulfilment or manufacturing agreement.",
  },
  {
    title: "Stage 5 — Proof it pays members",
    requirement: "First distribution run through escrow to equity holders.",
  },
];

const DEMO_FEATURES = [
  {
    title: "Escrow release tracker",
    description:
      "Live view of what the escrow agent holds on every project you back, and what releases on which milestone. Funded by failed-asset value, not by fees.",
    targetCents: 400000,
    votes: 34,
  },
  {
    title: "Diligence panel stipends",
    description:
      "Pay members who write the diligence notes everyone else reads. Flat rate per accepted note, reviewed by two Operators.",
    targetCents: 250000,
    votes: 28,
  },
  {
    title: "Member legal hour",
    description:
      "A pooled retainer so any member can get one hour with a licensed practitioner on an IP Desk draft before filing.",
    targetCents: 600000,
    votes: 41,
  },
  {
    title: "Reserve audit, published quarterly",
    description:
      "An outside accountant confirms the Mutual Cover Reserve balance and the coverage ratio, and the report is public.",
    targetCents: 300000,
    votes: 52,
  },
];

const DEMO_PROPOSALS = [
  {
    title: "Publish the coverage ratio on every project page",
    body: "Right now the Mutual Cover Reserve ratio lives at the Hub. Members deciding on a draw should see it at the moment of the decision, not one page away. This proposal puts the current ratio and the plain-language caveat on every project room and every draw card. Cost: engineering time only. Risk: a low ratio shown at the decision point will reduce ticket volume. That is the correct outcome if the ratio is genuinely low.",
  },
  {
    title: "Cap Forge Club pitch fees at $1,500 regardless of capital goal",
    body: "The fee scale currently tops out at $2,500 for very large capital goals. Large goals are exactly the pitches most likely to be unrealistic, and a high fee filters serious from unserious badly — it filters rich from not-rich. Cap the fee at $1,500 and add a mandatory diligence panel review for any goal above $500,000 instead. Cost: less fee revenue on large pitches. Benefit: the filter becomes competence rather than capital.",
  },
  {
    title: "Adult content stays third-party-hosted until the Reserve clears 25%",
    body: "Sole Society's phase 2 involves a separate entity, a high-risk processor and a records custodian. If that entity is halted, the Reserve is what covers its members. Binding the phase-2 launch to a Reserve coverage ratio of at least 25% means the cover exists before the risk does. Cost: delay. Benefit: the promise made to those members is one the network can actually keep.",
  },
];

export const seed = {
  status: base.handler(async () => {
    const [m] = await db.select({ c: sql<number>`count(*)` }).from(schema.members);
    return { members: Number(m?.c ?? 0), seeded: Number(m?.c ?? 0) > 0 };
  }),

  /** Idempotent demo data: members, projects, milestones, tickets, market, governance. */
  run: base.input(z.object({ force: z.boolean().default(false) })).handler(async ({ input }) => {
    const [existing] = await db.select({ c: sql<number>`count(*)` }).from(schema.members);
    if (Number(existing?.c ?? 0) > 0 && !input.force) {
      return { skipped: true, message: "Already seeded" };
    }

    const ids = new Map<string, number>();
    for (const m of DEMO_MEMBERS) {
      const [row] = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.handle, m.handle));
      if (row) {
        ids.set(m.handle, row.id);
        continue;
      }
      const [created] = await db
        .insert(schema.members)
        .values({
          handle: m.handle,
          displayName: m.displayName,
          email: m.email,
          role: m.role,
          level: m.level,
          points: m.points,
          clout: m.clout,
          walletCents: m.walletCents,
          kycStatus: m.kycStatus,
          world: m.world,
          homeBrand: m.homeBrand,
          bio: m.bio,
          ongoingAccess: m.level >= 2,
          createdAt: new Date(Date.now() - 40 * 86400000),
        })
        .returning();
      ids.set(m.handle, created.id);
    }

    for (const p of DEMO_PROJECTS) {
      const creatorId = ids.get(p.creator);
      if (!creatorId) continue;
      const fee = pitchFeeCents(p.capitalGoalCents, p.riskTier);
      const [project] = await db
        .insert(schema.projects)
        .values({
          creatorId,
          title: p.title,
          tagline: p.tagline,
          description: p.description,
          brand: p.brand,
          category: p.category,
          riskTier: p.riskTier,
          capitalGoalCents: p.capitalGoalCents,
          pitchFeeCents: fee,
          pitchFormat: p.pitchFormat,
          equityOfferedBp: p.equityOfferedBp,
          stage: p.stage,
          status: p.status ?? "live",
          escrowVendor: p.escrowVendor,
          escrowFeeCents: ESCROW_FEE_CENTS,
          escrowStatus: "assigned",
          lastActivityAt: new Date(Date.now() - (p.idleDays ?? 1) * 86400000),
          createdAt: new Date(Date.now() - (p.idleDays ?? 1) * 86400000 - 7 * 86400000),
          defaultReason:
            p.status === "default_notice"
              ? "No milestone evidence for 58 days and no reply in the project room. Cure window open, escrow frozen not seized."
              : null,
          graceUntil: p.status === "default_notice" ? daysFromNow(9) : null,
        })
        .returning();

      await db.insert(schema.milestones).values(
        MILESTONE_TEMPLATES.map((m, i) => ({
          projectId: project.id,
          stage: i + 1,
          title: m.title,
          requirement: m.requirement,
          pointValue: pointValueForStage(i + 1),
          status: i + 1 < p.stage ? "verified" : i + 1 === p.stage ? "open" : "locked",
          evidence:
            i + 1 < p.stage
              ? "Evidence accepted by the escrow reviewer and published in the project room."
              : null,
          verifiedAt: i + 1 < p.stage ? new Date(Date.now() - 20 * 86400000) : null,
          dueAt: daysFromNow(30 * (i + 1)),
        })),
      );

      await addFee(creatorId, project.id, fee, p);
    }

    await seedTickets(ids);
    await db.insert(schema.features).values(
      DEMO_FEATURES.map((f) => ({
        title: f.title,
        description: f.description,
        targetCents: f.targetCents,
        votes: f.votes,
        fundedCents: Math.round(f.targetCents * 0.2),
        status: "funding",
      })),
    );
    await db.insert(schema.proposals).values(
      DEMO_PROPOSALS.map((p) => ({
        title: p.title,
        body: p.body,
        closesAt: daysFromNow(11),
        yesWeight: 0,
        noWeight: 0,
      })),
    );

    const houseId = ids.get("house")!;
    await db.insert(schema.notices).values({
      memberId: houseId,
      kind: "grace",
      title: "Simulated network — no real money moves",
      body: "Every wallet, escrow hold and fee on this build is a ledger entry. No processor is connected and no security is offered or sold.",
      recoveryPath: "The path to operating legally is laid out, costed, at /compliance.",
    });

    await seedActivity();
    return { seeded: true, members: ids.size, projects: DEMO_PROJECTS.length };
  }),

  /** Idempotent: income runs on mature projects and one submission waiting for the escrow desk. */
  activity: base.handler(() => seedActivity()),
};

async function seedActivity() {
  const [d] = await db.select({ c: sql<number>`count(*)` }).from(schema.distributions);
  if (Number(d?.c ?? 0) > 0) return { skipped: true };
  const all = await db.select().from(schema.projects);
  let runs = 0;
  for (const p of all.filter((x) => x.stage >= 3 && x.status === "live")) {
    const gross = Math.round(p.capitalGoalCents * 0.06);
    await runDistribution({ projectId: p.id, grossCents: gross, period: "2026-08", note: "Seed: reported revenue" });
    await runDistribution({
      projectId: p.id,
      grossCents: Math.round(gross * 1.18),
      period: "2026-09",
      note: "Seed: reported revenue",
    });
    runs += 2;
  }
  const early = all.find((x) => x.stage <= 2 && x.status === "live");
  if (early) {
    await db
      .update(schema.milestones)
      .set({
        status: "submitted",
        evidence:
          "Signed letters of intent from three buyers, a bank statement export showing the first $1,180 of pre-orders, and a 4-minute walkthrough of the working prototype.",
      })
      .where(
        and(eq(schema.milestones.projectId, early.id), eq(schema.milestones.stage, early.stage)),
      );
  }
  return { runs, submittedFor: early?.id ?? null };
}

async function addFee(creatorId: number, projectId: number, fee: number, p: DemoProject) {
  await db.insert(schema.ledger).values([
    {
      kind: "pitch_fee",
      amountCents: fee,
      memberId: creatorId,
      projectId,
      bucket: "house",
      note: `Pitch listing fee (${p.riskTier} risk, $${(p.capitalGoalCents / 100).toLocaleString()} goal)`,
    },
    {
      kind: "house_fee",
      amountCents: Math.round(fee * 0.075),
      memberId: creatorId,
      projectId,
      bucket: "house",
      note: "House share of pitch fee",
    },
    {
      kind: "reserve_contribution",
      amountCents: Math.round(fee * 0.025),
      memberId: creatorId,
      projectId,
      bucket: "reserve",
      note: "Reserve share of pitch fee",
    },
    {
      kind: "escrow_fee",
      amountCents: ESCROW_FEE_CENTS,
      memberId: creatorId,
      projectId,
      bucket: "escrow",
      note: `Escrow retainer to ${p.escrowVendor}`,
    },
  ]);
}

/** A handful of tickets so portfolios, equity and the rate curve are not empty. */
async function seedTickets(ids: Map<string, number>) {
  const projects = await db.select().from(schema.projects);
  const backers = ["nkem", "juno", "sol", "vex", "dee"];
  for (const project of projects) {
    for (const handle of backers) {
      const memberId = ids.get(handle);
      if (!memberId || memberId === project.creatorId) continue;
      if (Math.random() > 0.55) continue;
      const amount = 1000;
      const fee = 100;
      const escrowed = amount - fee;
      const points = pointValueForStage(project.stage);
      const equityBp = Math.max(
        1,
        Math.round((escrowed / project.capitalGoalCents) * project.equityOfferedBp),
      );
      await db.insert(schema.investments).values({
        projectId: project.id,
        memberId,
        amountCents: amount,
        pointsAwarded: points,
        equityBp,
        stage: project.stage,
        houseFeeCents: fee,
        escrowStatus: "held",
        createdAt: new Date(Date.now() - Math.round(Math.random() * 20) * 86400000),
      });
      await db
        .update(schema.projects)
        .set({
          raisedCents: project.raisedCents + escrowed,
          backerCount: project.backerCount + 1,
          equityAllocatedBp: project.equityAllocatedBp + equityBp,
        })
        .where(eq(schema.projects.id, project.id));
      await db.insert(schema.ledger).values([
        {
          kind: "investment",
          amountCents: escrowed,
          memberId,
          projectId: project.id,
          bucket: "escrow",
          note: `Ticket escrowed with ${project.escrowVendor}`,
        },
        {
          kind: "house_fee",
          amountCents: 75,
          memberId,
          projectId: project.id,
          bucket: "house",
          note: "House share of ticket",
        },
        {
          kind: "reserve_contribution",
          amountCents: 25,
          memberId,
          projectId: project.id,
          bucket: "reserve",
          note: "Reserve share of ticket",
        },
      ]);
      await db.insert(schema.draws).values({
        memberId,
        projectId: project.id,
        weekKey: "2026-W38",
        decision: "yes",
        drawnAt: new Date(Date.now() - 9 * 86400000),
        decidedAt: new Date(Date.now() - 9 * 86400000),
      });
    }
  }

  // A thin points book so the Exchange has a rate and depth.
  const seller = ids.get("juno")!;
  const seller2 = ids.get("sol")!;
  const buyer = ids.get("nkem")!;
  await db.insert(schema.pointListings).values([
    {
      sellerId: seller,
      points: 120,
      priceCentsPerPoint: 6,
      status: "filled",
      buyerId: buyer,
      filledAt: new Date(Date.now() - 6 * 86400000),
    },
    {
      sellerId: seller2,
      points: 200,
      priceCentsPerPoint: 5,
      status: "filled",
      buyerId: buyer,
      filledAt: new Date(Date.now() - 3 * 86400000),
    },
    { sellerId: seller, points: 90, priceCentsPerPoint: 7, status: "open" },
    { sellerId: seller2, points: 150, priceCentsPerPoint: 8, status: "open" },
  ]);
}
