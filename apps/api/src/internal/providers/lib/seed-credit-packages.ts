/**
 * Seed CreditPackage collection with default credit purchase packages.
 * Uses $setOnInsert for idempotency — re-running never overwrites admin edits.
 */

import { getDb } from '../../../db/client.js';
import { seedPackage } from '../../../repositories/credit-packages.js';
import { log } from '../../../lib/logger.js';

interface CreditPackageSeed {
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  sortOrder: number;
}

const SEED_PACKAGES: CreditPackageSeed[] = [
  { packageId: 'credits_1000', name: '1,000 Credits', credits: 1000, price: 500, currency: 'usd', sortOrder: 0 },
  { packageId: 'credits_5000', name: '5,000 Credits', credits: 5000, price: 2000, currency: 'usd', sortOrder: 1 },
  { packageId: 'credits_10000', name: '10,000 Credits', credits: 10000, price: 3500, currency: 'usd', sortOrder: 2 },
  { packageId: 'credits_50000', name: '50,000 Credits', credits: 50000, price: 15000, currency: 'usd', sortOrder: 3 },
];

export async function seedCreditPackages(): Promise<{ seeded: number; skipped: number }> {
  const db = getDb();

  let seeded = 0;
  let skipped = 0;

  for (const pkgData of SEED_PACKAGES) {
    try {
      // `ON CONFLICT DO NOTHING RETURNING`, so an empty result IS "already
      // seeded". The source caught a duplicate-key error to reach the same
      // conclusion, which on Postgres cannot distinguish a duplicate from a
      // dropped connection — that catch would answer "already seeded" to an
      // infrastructure failure, and a failed statement also aborts the whole
      // transaction, so the recovery would not work at all. Here no statement
      // fails and a real failure still propagates to the caller.
      const inserted = await seedPackage(db, {
        packageId: pkgData.packageId,
        name: pkgData.name,
        credits: pkgData.credits,
        price: pkgData.price,
        currency: pkgData.currency,
        sortOrder: pkgData.sortOrder,
        isActive: true,
      });

      if (inserted) {
        seeded++;
        log.seed.info({ packageId: pkgData.packageId }, 'Created CreditPackage');
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      log.seed.error({ err: error, packageId: pkgData.packageId }, 'Error seeding credit package');
    }
  }

  log.seed.info({ seeded, skipped }, 'CreditPackage seeding complete');
  return { seeded, skipped };
}
