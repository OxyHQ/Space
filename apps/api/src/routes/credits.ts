import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/client.js';
import { dailyCreditUsageByUser } from '../repositories/apiKeyUsage.js';
import { getOrCreateUserCredits, refreshCreditsIfNeeded } from '../repositories/userCredits.js';
import { log } from '../lib/logger.js';
import { sanitizeMessage } from '../lib/errors/sanitize.js';

const router = Router();
const getSafeErrorMessage = (error: unknown, fallback: string): string =>
  sanitizeMessage(error instanceof Error ? error.message : fallback);

router.get('/', authenticateToken, async (req, res) => {
  try {
    const db = getDb();

    // `getOrCreate` first, then refresh — the source's two steps, and the order
    // matters: `refreshCreditsIfNeeded` updates a row and reports nothing when
    // there is none, so it cannot create the account.
    await getOrCreateUserCredits(db, req.user!.id);
    const { row } = await refreshCreditsIfNeeded(db, req.user!.id);
    if (!row) {
      // The row was created a statement ago; its absence here means someone
      // deleted it mid-request, which is not a 200.
      res.status(500).json({ error: 'Failed to fetch credits' });
      return;
    }

    res.json({
      credits: row.creditsFree + row.creditsPaid,
      freeCredits: row.creditsFree,
      freeLimit: row.creditsFreeLimit,
      paidCredits: row.creditsPaid,
      dailyRefresh: row.creditsDailyRefresh,
      lastRefresh: row.creditsLastRefresh,
    });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credits') });
  }
});

// Get daily credit usage history
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    const periodMap: Record<string, number> = { '24h': 1, '48h': 2, '72h': 3, '7d': 7, '30d': 30 };
    const days = periodMap[period] ?? 7;
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    // Returns only days that HAVE usage, exactly as the `$group` did. The gaps
    // are filled below, which is where the source filled them.
    const usage = await dailyCreditUsageByUser(getDb(), req.user!.id, since);

    // Build a complete array with all days (fill gaps with 0)
    const result: { date: string; used: number }[] = [];
    const usageMap = new Map(usage.map((u) => [u.date, u.used]));
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, used: usageMap.get(key) || 0 });
    }

    res.json(result);
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Usage error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credit usage') });
  }
});

export default router;
