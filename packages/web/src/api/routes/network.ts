import { sql } from "drizzle-orm";
import { base } from "../middleware/errors";
import { db } from "../database/client";
import * as schema from "../database/schema";
import {
  CANCEL_CLAWBACK_RATE,
  ESCROW_FEE_CENTS,
  HOUSE_RATE,
  LEVELS,
  MAX_INVEST_CENTS,
  RESERVE_RATE,
} from "../lib/economy";

/** The brands, each its own entity, cooperating through the Hub. */
export const BRANDS = [
  {
    key: "hub",
    name: "Kinship Hub",
    domain: "kinship.club",
    path: "/hub",
    role: "Trust layer",
    pitch: "Identity, the Mutual Cover Reserve, member scores, and the votes that bind the network.",
    entity: "Member co-operative. Holds the Reserve and nothing else.",
    risk: "Lowest. No project capital ever sits here.",
  },
  {
    key: "forge",
    name: "Forge Club",
    domain: "forge.club",
    path: "/forge",
    role: "The engine",
    pitch: "Pitch anything legal, draw opportunities, back them $10 at a time, explore simulated equity.",
    entity: "Operating LLC. Reg CF path via a registered funding portal partner.",
    risk: "Medium. Most capital and most regulatory surface.",
  },
  {
    key: "orbital",
    name: "Orbital Works",
    domain: "orbitalworks.science",
    path: "/orbital",
    role: "Deep tech",
    pitch: "Space, materials, biotech, energy. PhD diligence panels, longer milestones, accredited-only tranches.",
    entity: "Separate LLC. Reg D 506(c) with verified accredited investors.",
    risk: "High technical and capital-loss risk. The intended accredited route still requires legal review.",
  },
  {
    key: "sole",
    name: "Sole Society",
    domain: "solesociety.market",
    path: "/sole",
    role: "Creator commerce",
    pitch: "Feet and worn-apparel creator businesses: brand, storefront, payments, fulfilment. No judgment, every law respected.",
    entity: "Separate LLC. High-risk processor, third-party hosting, strict age and consent verification.",
    risk: "Content, consent, processor and securities risks require independent review.",
  },
] as const;

const COMPLIANCE_TRACKS = [
  {
    title: "Securities: stop being the issuer",
    now: "Simulated. Nothing on this build is an offer or a sale of a security.",
    path: [
      "Partner with a FINRA-registered funding portal for Reg CF rounds — the portal takes the intermediary liability and the filing obligations, at roughly 3-5% of the raise.",
      "Run Orbital Works as Reg D 506(c) with third-party accreditation verification, which removes the general-solicitation problem entirely.",
      "Keep Forge Club stage-1 tickets inside the $10 cap and the Reg CF per-investor limits so no member can be harmed enough to attract an enforcement theory.",
      "File Form C through the portal; never hold investor cash in a platform account.",
    ],
    cost: "Portal fee on raises, roughly $15-40k a year for securities counsel on retainer.",
  },
  {
    title: "Money movement: never touch the float",
    now: "Simulated ledger. No processor, no custody, no transmission.",
    path: [
      "Stripe Connect with separate charges and transfers, so funds settle to creator-connected accounts, not to us.",
      "Escrow through licensed third-party agents at $200 a project — the agent holds, releases, and is liable for the hold.",
      "Points are a closed-loop platform credit with no cash-out until a money-transmitter analysis clears; the Exchange settles in club credit until then.",
      "Get a written state-by-state MTL analysis before any cash-out feature ships. This is the single most expensive thing to get wrong.",
    ],
    cost: "$200 per project to the escrow agent, Stripe's rates, one-time $10-20k for the MTL analysis.",
  },
  {
    title: "Identity: KYC before capital",
    now: "Simulated tiers you can set yourself.",
    path: [
      "Persona or Sumsub for KYC and sanctions screening at $1-3 a check, webhook-written status.",
      "Accreditation verification through a third-party service for Orbital Works tranches.",
      "Age and consent verification for Sole Society creators via government-ID match, plus 2257-style record-keeping held by the hosting partner.",
      "No capital moves on any brand before the member's tier is written by the vendor, not by us.",
    ],
    cost: "$1-3 per verification, plus the hosting partner's compliance fee on Sole Society.",
  },
  {
    title: "Token and DAO: governance, not fundraising",
    now: "Not deployed. Design only.",
    path: [
      "If a token ships, it is a governance token with locked liquidity at a fixed starting value and no promise of appreciation — that promise is what turns a token into a security.",
      "Liquidity locked on a DEX for a fixed term, lock verifiable on-chain, and the lock published at the Hub.",
      "Voting weight is 1 + sqrt(clout), earned by contribution, not bought.",
      "Get a token-specific legal opinion before deployment, in every jurisdiction where members can hold it. Skip this and the whole network is exposed, not just the token.",
    ],
    cost: "$25-60k for a credible multi-jurisdiction token opinion. Do not deploy without it.",
  },
  {
    title: "Content: separate the risk",
    now: "Sole Society covers feet and worn apparel. Adult content is not hosted here.",
    path: [
      "Phase 1: feet and worn-apparel commerce preparation. No full adult content is hosted or sold in this build.",
      "Phase 2: full adult content on a compliant third-party host only, behind an appropriate processor, independent entity and records custodian. It is not hosted on this platform.",
      "Written consent and model release per asset, stored with the records custodian, not on the platform.",
      "Never commingle: an adult-content entity sharing a bank account with an investing entity is how both get shut off.",
    ],
    cost: "High-risk processing at 4-8%, plus a records custodian retainer.",
  },
  {
    title: "Resilience: one brand falls, members are covered",
    now: "Reserve accrues 25% of every house fee from day one.",
    path: [
      "Each brand incorporates separately with its own bank account, books, and counsel.",
      "The Hub co-operative holds only the Reserve and never project capital.",
      "If a regulator halts one brand: that brand stops taking money the same day, files for a compliance path, and the Reserve is released by member vote to make its backers whole pro-rata.",
      "Publish the coverage ratio continuously. A partial cover stated honestly keeps confidence; an implied guarantee destroys it the first time it is tested.",
    ],
    cost: "Roughly $2-4k per entity to form, plus annual filings and separate bookkeeping.",
  },
];

export const network = {
  brands: base.handler(() => BRANDS),

  rules: base.handler(() => ({
    houseRate: HOUSE_RATE,
    reserveRate: RESERVE_RATE,
    maxInvestCents: MAX_INVEST_CENTS,
    escrowFeeCents: ESCROW_FEE_CENTS,
    clawbackRate: CANCEL_CLAWBACK_RATE,
    levels: LEVELS,
    drawRule:
      "One open decision at a time. Yes puts up to $10 in; bye closes that round to you for good. The next draw unlocks the moment you answer. Three a week at Level 0.",
    ceilingRule:
      "The $10 per-project ceiling never moves. What grows is the points a $10 ticket earns: 10 at stage 1, then 20, 40, 80, 160 as milestones verify.",
    equityRule:
      "Tickets buy equity in basis points, pro-rata against the slice the creator offered. Foreclosure does not cancel backer equity.",
    houseRule:
      "The house takes 10% of every transaction. A quarter of that goes to the Mutual Cover Reserve before the house keeps anything. Value from failed assets funds member-value features.",
  })),

  compliance: base.handler(() => ({
    posture:
      "This build simulates all money movement. No security is offered or sold, no funds are held, no payment processor is connected. Everything below is the path from here to operating legally, with the cost of each step stated.",
    tracks: COMPLIANCE_TRACKS,
    principle:
      "The strategy is not to argue with regulators. It is to hand every regulated function to a licensed third party who is already allowed to do it — portal, escrow agent, KYC vendor, processor, records custodian — and keep the platform as software plus a marketplace.",
  })),

  stats: base.handler(async () => {
    const [m] = await db.select({ c: sql<number>`count(*)` }).from(schema.members);
    const [p] = await db.select({ c: sql<number>`count(*)` }).from(schema.projects);
    const [i] = await db
      .select({ c: sql<number>`count(*)`, sum: sql<number>`sum(${schema.investments.amountCents})` })
      .from(schema.investments);
    const [f] = await db.select({ c: sql<number>`count(*)` }).from(schema.ipFilings);
    const [d] = await db.select({ c: sql<number>`count(*)` }).from(schema.draws);
    return {
      members: Number(m?.c ?? 0),
      projects: Number(p?.c ?? 0),
      tickets: Number(i?.c ?? 0),
      backedCents: Number(i?.sum ?? 0),
      filings: Number(f?.c ?? 0),
      decisions: Number(d?.c ?? 0),
    };
  }),
};
