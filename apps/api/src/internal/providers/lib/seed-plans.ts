/**
 * Seed the `plans` table with default subscription plans.
 * Insert-only for the admin-managed columns — re-running never overwrites admin
 * edits — except `modelIds`, which the seed owns and re-syncs on every run.
 *
 * Features are managed via the `features` + `plan_features` tables
 * (see seed-features.ts). This file only seeds plan metadata and modelIds.
 */

import { getDb } from '../../../db/client.js';
import { seedPlan } from '../../../repositories/plans.js';
import { log } from '../../../lib/logger.js';

interface PlanSeed {
  planId: string;
  name: string;
  product: 'clarity' | 'codea';
  creditsPerMonth: number;
  dailyFreeCredits: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  isFree: boolean;
  modelIds: string[];
}

// ─── modelIds (cumulative) ─────────────────────────────────────────

const FREE_MODEL_IDS = ['clarity-fast', 'clarity-v1', 'clarity-v1'];
const GO_MODEL_IDS = [...FREE_MODEL_IDS, 'clarity-v1', 'clarity-v1', 'clarity-v1', 'clarity-v1', 'clarity-v1', 'clarity-v1'];
const PRO_MODEL_IDS = [...GO_MODEL_IDS, 'clarity-pro', 'clarity-thinking', 'clarity-pro-max', 'clarity-pro'];

// ─── Seed data ─────────────────────────────────────────────────────

const SEED_PLANS: PlanSeed[] = [
  // ─── Clarity Plans ───────────────────────────────────────────
  {
    planId: 'free',
    name: 'Free',
    product: 'clarity',
    creditsPerMonth: 0,
    dailyFreeCredits: 300,
    monthlyPrice: 0,
    annualPrice: 0,
    currency: 'usd',
    subtitle: 'subscribe.freeUsage',
    creditsLabel: '300 credits / day',
    isFeatured: false,
    sortOrder: 0,
    isFree: true,
    modelIds: FREE_MODEL_IDS,
  },
  {
    planId: 'go',
    name: 'Go',
    product: 'clarity',
    creditsPerMonth: 4000,
    dailyFreeCredits: 300,
    monthlyPrice: 399,
    annualPrice: 3830,
    currency: 'usd',
    subtitle: 'subscribe.goUsage',
    creditsLabel: '4,000 credits / mo',
    isFeatured: false,
    sortOrder: 1,
    isFree: false,
    modelIds: GO_MODEL_IDS,
  },
  {
    planId: 'pro',
    name: 'Pro',
    product: 'clarity',
    creditsPerMonth: 10000,
    dailyFreeCredits: 300,
    monthlyPrice: 999,
    annualPrice: 9590,
    currency: 'usd',
    subtitle: 'subscribe.proUsage',
    creditsLabel: '10,000 credits / mo',
    isFeatured: true,
    sortOrder: 2,
    isFree: false,
    modelIds: PRO_MODEL_IDS,
  },
  {
    planId: 'max',
    name: 'Max',
    product: 'clarity',
    creditsPerMonth: 50000,
    dailyFreeCredits: 300,
    monthlyPrice: 4999,
    annualPrice: 47990,
    currency: 'usd',
    subtitle: 'subscribe.maxUsage',
    creditsLabel: '50,000 credits / mo',
    isFeatured: false,
    sortOrder: 3,
    isFree: false,
    modelIds: PRO_MODEL_IDS,
  },
  {
    planId: 'ultra',
    name: 'Ultra',
    product: 'clarity',
    creditsPerMonth: 100000,
    dailyFreeCredits: 300,
    monthlyPrice: 9999,
    annualPrice: 95990,
    currency: 'usd',
    subtitle: 'subscribe.ultraUsage',
    creditsLabel: '100,000 credits / mo',
    isFeatured: false,
    sortOrder: 4,
    isFree: false,
    modelIds: PRO_MODEL_IDS,
  },

  // ─── Codea Plans ──────────────────────────────────────────
  {
    planId: 'codea-pro',
    name: 'Codea Pro',
    product: 'codea',
    creditsPerMonth: 10000,
    dailyFreeCredits: 300,
    monthlyPrice: 999,
    annualPrice: 9590,
    currency: 'usd',
    subtitle: 'subscribe.codeaProUsage',
    creditsLabel: '10,000 credits / mo',
    isFeatured: false,
    sortOrder: 0,
    isFree: false,
    modelIds: ['clarity-v1', 'clarity-pro', 'clarity-thinking'],
  },
  {
    planId: 'codea-max',
    name: 'Codea Max',
    product: 'codea',
    creditsPerMonth: 50000,
    dailyFreeCredits: 300,
    monthlyPrice: 4999,
    annualPrice: 47990,
    currency: 'usd',
    subtitle: 'subscribe.codeaMaxUsage',
    creditsLabel: '50,000 credits / mo',
    isFeatured: true,
    sortOrder: 1,
    isFree: false,
    modelIds: ['clarity-v1', 'clarity-pro', 'clarity-thinking'],
  },
];

export async function seedPlans(): Promise<{ seeded: number; skipped: number }> {
  const db = getDb();

  let seeded = 0;
  let skipped = 0;

  for (const planData of SEED_PLANS) {
    try {
      // `modelIds` is code-managed and re-synced on every run; every other
      // column is admin-managed and written only on insert. `seedPlan` is an
      // `ON CONFLICT DO UPDATE` over that one column for exactly that reason —
      // a plain `DO NOTHING` would read correctly and quietly stop syncing it.
      //
      // No duplicate-key catch: on Postgres an exception cannot tell a
      // duplicate from a dropped connection, so catching one would answer
      // "already seeded" to an infrastructure failure. `RETURNING (xmax = 0)`
      // makes the answer part of the statement's result instead.
      const inserted = await seedPlan(db, {
        planId: planData.planId,
        name: planData.name,
        product: planData.product,
        creditsPerMonth: planData.creditsPerMonth,
        dailyFreeCredits: planData.dailyFreeCredits,
        monthlyPrice: planData.monthlyPrice,
        annualPrice: planData.annualPrice,
        currency: planData.currency,
        subtitle: planData.subtitle,
        creditsLabel: planData.creditsLabel,
        isFeatured: planData.isFeatured,
        sortOrder: planData.sortOrder,
        isFree: planData.isFree,
        modelIds: planData.modelIds,
        isActive: true,
      });

      if (inserted) {
        seeded++;
        log.seed.info({ planId: planData.planId, name: planData.name }, 'Created Plan');
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      log.seed.error({ err: error, planId: planData.planId }, 'Error seeding plan');
    }
  }

  log.seed.info({ seeded, skipped }, 'Plan seeding complete');
  return { seeded, skipped };
}
