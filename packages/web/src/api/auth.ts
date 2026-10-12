import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { runableManagedAuth } from "@runablehq/managed-auth/server";
import { db } from "./database/client";

/**
 * Trusted origins are an explicit allow-list: the configured site URL, the local dev
 * server, and any comma-separated extras in AUTH_TRUSTED_ORIGINS (custom domains).
 * Request origins are never echoed back as trusted.
 */
function trustedOrigins() {
  const list = new Set<string>(["http://localhost:4200", "http://127.0.0.1:4200"]);
  for (const raw of [process.env.WEBSITE_URL, ...(process.env.AUTH_TRUSTED_ORIGINS ?? "").split(",")]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      list.add(new URL(value).origin);
    } catch {
      console.warn("[auth] Ignored malformed trusted origin entry");
    }
  }
  return [...list];
}

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env.WEBSITE_URL,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    // No email sender is configured, so verification mail cannot be delivered.
    requireEmailVerification: false,
  },
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: trustedOrigins(),
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/email": { window: 60, max: 6 },
      "/sign-up/email": { window: 300, max: 5 },
    },
  },
  plugins: [
    ...runableManagedAuth({
      applicationId: process.env.APPLICATION_ID!,
      issuer: process.env.VITE_RUNABLE_AUTH_ISSUER!,
    }),
    expo(),
  ],
});
