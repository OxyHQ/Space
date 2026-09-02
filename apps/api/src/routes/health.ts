import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getRedisClient } from '../lib/redis.js';
import { log } from '../lib/logger.js';

const router = Router();

interface HealthSnapshot {
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptime: number;
  postgres: 'connected' | 'disconnected';
  redis: 'configured' | 'unavailable';
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}

let healthCache: { data: HealthSnapshot; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000;

async function getHealthSnapshot(): Promise<HealthSnapshot> {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  let postgres: HealthSnapshot['postgres'] = 'disconnected';
  try {
    await getDb().execute(sql`select 1`);
    postgres = 'connected';
  } catch (error) {
    log.general.warn({ err: error }, 'Readiness: database query failed');
  }

  const memory = process.memoryUsage();
  const snapshot: HealthSnapshot = {
    status: postgres === 'connected' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    postgres,
    redis: getRedisClient() ? 'configured' : 'unavailable',
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024),
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
    },
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

router.get('/', async (_req, res) => {
  try {
    const snapshot = await getHealthSnapshot();
    res.status(snapshot.status === 'healthy' ? 200 : 503).json(snapshot);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Health check failed');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  }
});

router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

router.get('/ready', async (_req, res) => {
  try {
    await getDb().execute(sql`select 1`);
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    log.general.warn({ err: error }, 'Readiness: database query failed');
    res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }
});

export default router;
