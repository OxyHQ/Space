/**
 * Billing Admin API Routes
 * Read-only endpoints for viewing transactions, subscriptions, and user summaries
 */

import express, { Request, Response } from 'express';
import { getDb } from '../../../db/client.js';
import {
  countTransactions,
  listRecentTransactionsByUser,
  listTransactions,
} from '../../../repositories/transactions.js';
import {
  countSubscriptions,
  listSubscriptions,
  listSubscriptionsByUser,
} from '../../../repositories/subscriptions.js';
import { findUserCreditsById } from '../../../repositories/userCredits.js';
import { log } from '../../../lib/logger.js';

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePaging(limitStr: unknown, offsetStr: unknown): { limit: number; offset: number } {
  return {
    limit: Math.min(parseInt(limitStr as string) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    offset: parseInt(offsetStr as string) || 0,
  };
}

/**
 * GET /v1/billing/transactions
 * List transactions with pagination and optional filters
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { status, type, limit: limitStr, offset: offsetStr } = req.query;

    // An absent key means "no restriction" and must DROP the clause, not
    // compare against NULL — see `transactionFilter`.
    const filter = {
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof type === 'string' ? { type } : {}),
    };
    const { limit, offset } = parsePaging(limitStr, offsetStr);
    const db = getDb();

    const [transactions, total] = await Promise.all([
      listTransactions(db, filter, { limit, offset }),
      countTransactions(db, filter),
    ]);

    res.json({
      success: true,
      count: transactions.length,
      total,
      data: transactions,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing transactions');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/billing/subscriptions
 * List subscriptions with pagination and optional filters
 */
router.get('/subscriptions', async (req: Request, res: Response) => {
  try {
    const { status, product, limit: limitStr, offset: offsetStr } = req.query;

    const filter = {
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof product === 'string' ? { product } : {}),
    };
    const { limit, offset } = parsePaging(limitStr, offsetStr);
    const db = getDb();

    const [subscriptions, total] = await Promise.all([
      listSubscriptions(db, filter, { limit, offset }),
      countSubscriptions(db, filter),
    ]);

    res.json({
      success: true,
      count: subscriptions.length,
      total,
      data: subscriptions,
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error listing subscriptions');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/billing/user/:userId
 * Get billing summary for a specific user
 */
router.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    // Express types a route param as `string | string[]`. Mongoose accepted
    // either and cast; a repository takes a `string`, so the shape is checked
    // here rather than being asserted away.
    const { userId } = req.params;
    if (typeof userId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Invalid user id',
        code: 'INVALID_USER_ID',
      });
      return;
    }
    const db = getDb();

    const [credits, subscriptions, transactions] = await Promise.all([
      findUserCreditsById(db, userId),
      listSubscriptionsByUser(db, userId),
      listRecentTransactionsByUser(db, userId),
    ]);

    res.json({
      success: true,
      data: {
        credits,
        subscriptions,
        transactions,
      },
    });
  } catch (error: unknown) {
    log.providers.error({ err: error }, 'Error getting user billing summary');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
