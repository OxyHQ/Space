import { Router, Request, Response } from 'express';
import chatCompletionsRouter from './v1/chat-completions.js';
import modelsRouter from './v1/models.js';
import { authenticateTokenOrApiKey } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { getDb } from '../db/client.js';
import { getOrCreateUserCredits, refreshCreditsIfNeeded } from '../repositories/userCredits.js';
import { log } from '../lib/logger.js';

const router = Router();


router.get('/', (_req, res) => {
  res.json({
    message: 'AI Platform API v1',
    version: '1.0.0'
  });
});

// Public routes (no auth required)
router.use('/models', modelsRouter);

// Apply authentication to all other v1 routes (supports both JWT and API keys)
router.use(authenticateTokenOrApiKey);

// Apply rate limiting for API key authenticated requests
router.use(apiKeyRateLimit);

/**
 * GET /v1/me
 * Get current user info (works for any authenticated client)
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get user credits. The find-then-create pair collapses into one upsert,
    // and the four `300`s it repeated now come from `DEFAULT_FREE_CREDITS` in
    // the repository — one constant, so a new account here and a new account on
    // any other path cannot receive different grants.
    const db = getDb();
    await getOrCreateUserCredits(db, userId);
    const { row: userCredits } = await refreshCreditsIfNeeded(db, userId);
    if (!userCredits) {
      return res.status(500).json({ error: 'Failed to fetch user info' });
    }

    const authUser = req.user;
    const rawDisplayName = authUser?.displayName;
    const displayName = typeof rawDisplayName === 'string' ? rawDisplayName : undefined;

    res.json({
      id: userId,
      email: authUser?.email || '',
      name: displayName || authUser?.email || '',
      credits: {
        free: userCredits.creditsFree,
        paid: userCredits.creditsPaid,
        total: userCredits.creditsFree + userCredits.creditsPaid,
      },
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to fetch user info');
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

/**
 * POST /v1/resolve-model
 * Removed: direct provider resolution is internal-only.
 */
router.post('/resolve-model', async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Use /v1/chat/completions with Clarity model IDs. Direct model resolution is internal-only.',
  });
});

/**
 * POST /v1/report-usage
 * Removed: usage is tracked internally by the runtime.
 */
router.post('/report-usage', async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Usage is tracked automatically by Clarity runtime.',
  });
});

router.use('/chat/completions', chatCompletionsRouter);

export default router;
