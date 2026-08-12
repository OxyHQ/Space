import { Router } from 'express';
import { getDb } from '../db/client.js';
import {
  createFeedback,
  findFeedbackByIdForUser,
  listFeedbackByUser,
  type FeedbackRow,
} from '../repositories/feedback.js';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

const router = Router();

// All feedback routes require authentication
router.use(authenticateToken);

const VALID_TYPES = ['bug', 'feature', 'improvement', 'other'];

/**
 * The wire shape. `id`, never `_id` — and `metadata` is reassembled from the
 * three columns the sub-document became, so a client keeps reading one object
 * rather than three sibling keys.
 *
 * The list and detail routes used to `res.json(doc)` a Mongoose document, which
 * emitted `_id` and `__v` as well. Both are gone; this is the clean cut.
 */
function serializeFeedback(row: FeedbackRow) {
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    type: row.type,
    rating: row.rating,
    message: row.message,
    email: row.email,
    metadata: {
      platform: row.metadataPlatform,
      appVersion: row.metadataAppVersion,
      deviceInfo: row.metadataDeviceInfo,
    },
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * POST /feedback
 * Submit new feedback
 */
router.post('/', async (req, res) => {
  try {
    const { type, rating, message, email, metadata } = req.body;

    if (!type || !message) {
      res.status(400).json({ error: 'Type and message are required' });
      return;
    }

    if (!VALID_TYPES.includes(type)) {
      res.status(400).json({ error: 'Invalid feedback type' });
      return;
    }

    if (rating !== undefined && (rating < 1 || rating > 5)) {
      res.status(400).json({ error: 'Rating must be between 1 and 5' });
      return;
    }

    // The repository destructures `metadata` into its three declared fields,
    // reproducing Mongoose strict mode, which silently DROPPED every other key.
    // This body is unvalidated user input; passing it through whole would start
    // persisting what the source discarded.
    const feedback = await createFeedback(getDb(), {
      oxyUserId: req.user!.id,
      type,
      rating,
      message,
      email,
      metadata,
    });

    res.status(201).json({
      success: true,
      feedback: {
        id: feedback.id,
        type: feedback.type,
        message: feedback.message,
        createdAt: feedback.createdAt,
      },
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error submitting feedback');
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

/**
 * GET /feedback
 * Get user's feedback history
 */
router.get('/', async (req, res) => {
  try {
    const feedback = await listFeedbackByUser(getDb(), req.user!.id);

    res.json(feedback.map(serializeFeedback));
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error fetching feedback');
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

/**
 * GET /feedback/:id
 * Get specific feedback by ID
 */
router.get('/:id', async (req, res) => {
  try {
    // The owner is part of the WHERE clause, so another user's feedback is a
    // miss rather than a row this handler has to remember to reject.
    //
    // An id of the wrong SHAPE now 404s where Mongoose raised a CastError and
    // the catch turned it into a 500. `id` is a `text` column, so there is no
    // cast to fail — loud becomes quiet, and 404 is the right answer for
    // "no such feedback".
    const feedback = await findFeedbackByIdForUser(getDb(), req.params.id, req.user!.id);

    if (!feedback) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }

    res.json(serializeFeedback(feedback));
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error fetching feedback');
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

export default router;
