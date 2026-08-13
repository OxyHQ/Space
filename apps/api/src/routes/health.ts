import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getAllProviderHealth, type HealthMetrics } from '../lib/gateway-client.js';
import { getRedisClient } from '../lib/redis.js';
import { log } from '../lib/logger.js';

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid querying providers on every health check

let healthCache: { data: any; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

async function getHealthSnapshot() {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  // A real query, not a connection flag. `mongoose.connection.readyState` said
  // "connected" without proving the server would answer anything; a readiness
  // probe that cannot fail while the database is unusable is not a probe.
  let databaseStatus: 'connected' | 'disconnected' = 'disconnected';
  try {
    await getDb().execute(sql`select 1`);
    databaseStatus = 'connected';
  } catch (error) {
    log.general.warn({ err: error }, 'Readiness: database query failed');
  }

  let providersSummary = { total: 0, healthy: 0, unhealthy: 0, openCircuits: 0 };
  let providersReachable = false;
  try {
    const providers = await getAllProviderHealth();
    providersReachable = true;
    providersSummary = {
      total: providers.length,
      healthy: providers.filter((p: HealthMetrics) => p.isHealthy).length,
      unhealthy: providers.filter((p: HealthMetrics) => !p.isHealthy).length,
      openCircuits: providers.filter((p: HealthMetrics) => p.circuitState === 'open').length,
    };
  } catch {
    // Gateway unreachable — don't penalize health status
  }

  const mem = process.memoryUsage();
  const redis = getRedisClient();
  const redisStatus = redis ? 'connected' : 'unavailable';

  // Only require healthy providers if we could actually reach the gateway
  const isHealthy = databaseStatus === 'connected' && (!providersReachable || providersSummary.healthy > 0);

  const snapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    postgres: databaseStatus,
    redis: redisStatus,
    providers: providersSummary,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),       // MB
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024), // MB
    },
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

// Full health check with details
router.get('/', async (_req, res) => {
  try {
    const snapshot = await getHealthSnapshot();
    const statusCode = snapshot.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(snapshot);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Health check failed');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  }
});

// Liveness probe: process is running -> 200
// Used by k8s/DO App Platform to detect crashed processes
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe: the database answers a query + at least 1 provider healthy.
// Used by load balancers to decide if this instance should receive traffic.
router.get('/ready', async (_req, res) => {
  // Asserted with a statement rather than a connection flag: a pool can report
  // itself connected while every query fails, and this endpoint decides
  // whether traffic arrives.
  let databaseReady = false;
  try {
    await getDb().execute(sql`select 1`);
    databaseReady = true;
  } catch (error) {
    log.general.warn({ err: error }, 'Readiness: database query failed');
  }

  if (!databaseReady) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }

  try {
    const providers = await getAllProviderHealth();
    const hasHealthyProvider = providers.some((p: HealthMetrics) => p.isHealthy);
    if (!hasHealthyProvider && providers.length > 0) {
      return res.status(503).json({ status: 'not_ready', reason: 'no_healthy_providers' });
    }
  } catch {
    // If we can't check providers, still consider ready if the database is up
  }

  res.status(200).json({ status: 'ready' });
});

export default router;
