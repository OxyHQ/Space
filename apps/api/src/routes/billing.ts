import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authenticateToken, oxyClient } from '../middleware/auth.js';
import { getDb } from '../db/client.js';
import {
  addCredits,
  findUserCreditsByStripeCustomerId,
  getOrCreateUserCredits,
  setStripeCustomerId,
  type UserCreditsRow,
} from '../repositories/userCredits.js';
import {
  findLiveSubscription,
  setCancelAtPeriodEnd,
  updateSubscriptionPlan,
  updateSubscriptionStatus,
  upsertSubscriptionFromStripe,
  type SubscriptionRow,
} from '../repositories/subscriptions.js';
import {
  countTransactionsByUser,
  createCreditPurchase,
  createSubscriptionPayment,
  listTransactionsByUser,
  type TransactionRow,
} from '../repositories/transactions.js';
import { getPlans, getCreditPackages, getFeatures, getPlanFeatures, getAllClarityModels, type PlanFeatureData } from '../lib/gateway-client.js';
import { ensureStripePriceId } from '../lib/stripe-prices.js';
import { getUserEntitlements, invalidateEntitlementsCache } from '../lib/plan-access.js';
import { z } from 'zod';
import { log } from '../lib/logger.js';
import { sanitizeMessage } from '../lib/errors/index.js';

const router = Router();
const getSafeErrorMessage = (error: unknown, fallback: string): string =>
  sanitizeMessage(error instanceof Error ? error.message : fallback);

/**
 * The wire shape of a subscription. `id`, never `_id`, and the six flattened
 * `plan*` columns are reassembled into the `plan` object clients already read.
 *
 * Every one of them is nullable, because the webhook upsert is a writer Mongoose
 * validators never ran on — `price` in particular is
 * `isAnnual ? plan.annualPrice : plan.monthlyPrice`, which is `undefined` for a
 * gateway plan with no annual price. Mongo stored the field absent; NOT NULL
 * would have thrown inside a Stripe webhook and left a paying customer with no
 * subscription row at all.
 */
function serializeSubscription(row: SubscriptionRow) {
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripePriceId: row.stripePriceId,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    planId: row.planId,
    billingPeriod: row.billingPeriod,
    plan: {
      planId: row.planPlanId,
      name: row.planName,
      product: row.planProduct,
      creditsPerMonth: row.planCreditsPerMonth,
      price: row.planPrice,
      currency: row.planCurrency,
      billingPeriod: row.planBillingPeriod,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The wire shape of a transaction. `id`, never `_id`.
 *
 * `dedup` was `metadata.dedup` in Mongo and is a real column now; it is put back
 * under `metadata` so a client reading the ledger sees what it always saw. The
 * raw `metadata` jsonb is retained on the row for backfill fidelity and is NOT
 * emitted — historical rows may hold anything, and no current writer sets a key
 * other than `dedup`.
 */
function serializeTransaction(row: TransactionRow) {
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    stripeCustomerId: row.stripeCustomerId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    type: row.type,
    amount: row.amount,
    currency: row.currency,
    credits: row.credits,
    status: row.status,
    description: row.description,
    metadata: row.dedup === null ? null : { dedup: row.dedup },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not defined');
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
    });
  }
  return stripeInstance;
}

function getWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}

// Helper to get or create Stripe customer
async function getOrCreateStripeCustomer(userId: string, userCredits: UserCreditsRow): Promise<string> {
  let customerId = userCredits.stripeCustomerId;

  if (customerId) {
    try {
      await getStripe().customers.retrieve(customerId);
      return customerId;
    } catch {
      customerId = null;
    }
  }

  // Fetch email from Oxy
  let email: string | undefined;
  try {
    const oxyUser = await oxyClient.getUserById(userId);
    email = oxyUser?.email;
  } catch (e: unknown) {
    log.credits.error({ err: e }, 'Failed to fetch user from Oxy');
  }

  const customer = await getStripe().customers.create({
    email,
    metadata: { userId },
  });

  await setStripeCustomerId(getDb(), userId, customer.id);
  log.credits.info({ customerId: customer.id, userId }, 'Created Stripe customer');

  return customer.id;
}

router.get('/packages', async (_req: Request, res: Response) => {
  try {
    const packages = await getCreditPackages(true);
    res.json({
      packages: packages.map(p => ({
        id: p.packageId,
        name: p.name,
        credits: p.credits,
        price: p.price,
        currency: p.currency,
      })),
    });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching packages');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credit packages') });
  }
});

const createCheckoutSchema = z.object({
  packageId: z.string(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/credits', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { packageId, successUrl, cancelUrl } = createCheckoutSchema.parse(req.body);
    const userId = req.user!.id;

    const allPackages = await getCreditPackages(true);
    const pkg = allPackages.find(p => p.packageId === packageId);
    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package ID' });
    }

    const userCredits = await getOrCreateUserCredits(getDb(), userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const lineItem = pkg.stripePriceId
      ? { price: pkg.stripePriceId, quantity: 1 }
      : {
          price_data: {
            currency: pkg.currency,
            product_data: { name: pkg.name, description: `${pkg.credits.toLocaleString()} AI credits` },
            unit_amount: pkg.price,
          },
          quantity: 1,
        };

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [lineItem],
      mode: 'payment',
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, type: 'credit_purchase', packageId: pkg.packageId, credits: pkg.credits.toString() },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating checkout session');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create checkout session') });
  }
});

// Custom credit amount purchase
const CREDIT_PRICE_PER_1K_CENTS = 1000; // $10.00 per 1,000 credits
const MIN_CUSTOM_CREDITS = 100;
const MAX_CUSTOM_CREDITS = 1_000_000;

const customCreditsSchema = z.object({
  credits: z.number().int().min(MIN_CUSTOM_CREDITS).max(MAX_CUSTOM_CREDITS),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/custom-credits', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { credits, successUrl, cancelUrl } = customCreditsSchema.parse(req.body);
    const userId = req.user!.id;

    // Use best per-credit rate from active packages, fall back to constant
    const packages = await getCreditPackages(true);
    let pricePerCredit = CREDIT_PRICE_PER_1K_CENTS / 1000;
    if (packages.length > 0) {
      pricePerCredit = Math.min(...packages.map(p => p.price / p.credits));
    }

    const totalCents = Math.round(credits * pricePerCredit);
    if (totalCents < 50) {
      return res.status(400).json({ error: 'Minimum purchase amount is $0.50' });
    }

    const userCredits = await getOrCreateUserCredits(getDb(), userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `${credits.toLocaleString()} AI Credits`, description: 'Custom credit purchase' },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, type: 'credit_purchase', packageId: 'custom', credits: credits.toString() },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating custom credits checkout');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create custom credits checkout') });
  }
});

// Expose the per-credit rate so the frontend can show live pricing
router.get('/credit-price', async (_req: Request, res: Response) => {
  try {
    let pricePerCredit = CREDIT_PRICE_PER_1K_CENTS / 1000;
    const creditPricePackages = await getCreditPackages(true);
    if (creditPricePackages.length > 0) {
      pricePerCredit = Math.min(...creditPricePackages.map(p => p.price / p.credits));
    }
    res.json({ pricePerCreditCents: pricePerCredit, minCredits: MIN_CUSTOM_CREDITS, maxCredits: MAX_CUSTOM_CREDITS });
  } catch (error: unknown) {
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credit price') });
  }
});

router.get('/plans', async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const planFilter: Record<string, unknown> = { isActive: true };
    if (product) planFilter.product = product;

    const [dbPlans, rawFeatures, rawPlanFeatures] = await Promise.all([
      getPlans(planFilter),
      getFeatures(),
      getPlanFeatures(),
    ]);
    // Filter features/plan-features client-side (API may return all)
    const allFeatures = rawFeatures.filter(f => f.isActive !== false && f.isVisibleOnPricing !== false);
    const allPlanFeatures = rawPlanFeatures.filter(pf => pf.enabled !== false);

    // Build lookup: planId -> featureId -> PlanFeature mapping
    const pfMap: Record<string, Record<string, PlanFeatureData>> = {};
    for (const pf of allPlanFeatures) {
      if (!pfMap[pf.planId]) pfMap[pf.planId] = {};
      pfMap[pf.planId][pf.featureId] = pf;
    }

    // Load all Clarity models from providers API
    const modelMap: Record<string, { displayName: string; description?: string }> = {};
    try {
      const clarityModels = await getAllClarityModels();
      for (const m of clarityModels) {
        modelMap[m.id] = { displayName: m.name, description: m.description };
      }
    } catch { /* ignore */ }

    const plans = dbPlans.map(p => {
      const planId = p.planId;
      const planMappings = pfMap[planId] || {};

      // Build feature groups from Feature + PlanFeature collections
      const groupMap = new Map<string, { label: string; description?: string }[]>();

      for (const feat of allFeatures) {
        const mapping = planMappings[feat.featureId];
        if (!mapping) continue;

        const category = feat.category;
        if (!groupMap.has(category)) groupMap.set(category, []);

        groupMap.get(category)!.push({
          label: mapping.displayLabel || feat.label,
          description: mapping.displayDescription || feat.description,
        });
      }

      // Convert to array, preserving category order from features query
      const features: { category: string; items: { label: string; description?: string }[] }[] = [];
      const seenCategories = new Set<string>();
      for (const feat of allFeatures) {
        if (seenCategories.has(feat.category)) continue;
        const items = groupMap.get(feat.category);
        if (items && items.length > 0) {
          features.push({ category: feat.category, items });
          seenCategories.add(feat.category);
        }
      }

      // Insert "Models" group from modelIds (after Credits if present, else at start)
      const modelIds: string[] = p.modelIds || [];
      if (modelIds.length > 0) {
        const modelItems = modelIds
          .map(id => modelMap[id])
          .filter(Boolean)
          .map(m => ({ label: m!.displayName, description: m!.description }));

        if (modelItems.length > 0) {
          const insertAt = features.length > 0 && features[0].category === 'Credits' ? 1 : 0;
          features.splice(insertAt, 0, { category: 'Models', items: modelItems });
        }
      }

      return {
        id: planId,
        name: p.name,
        product: p.product,
        creditsPerMonth: p.creditsPerMonth,
        monthlyPrice: p.monthlyPrice,
        annualPrice: p.annualPrice,
        currency: p.currency,
        features,
        subtitle: p.subtitle,
        creditsLabel: p.creditsLabel,
        isFeatured: p.isFeatured,
        isFree: p.isFree,
        sortOrder: p.sortOrder,
      };
    });
    res.json({ plans });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching plans');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch plans') });
  }
});

const createSubscriptionSchema = z.object({
  planId: z.string(),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, billingPeriod, successUrl, cancelUrl } = createSubscriptionSchema.parse(req.body);
    const userId = req.user!.id;

    const matchingPlans = await getPlans({ planId, isActive: true, isFree: false });
    const plan = matchingPlans[0];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    const existingSubscription = await findLiveSubscription(getDb(), userId, plan.product);

    if (existingSubscription) {
      return res.status(409).json({
        error: 'You already have an active subscription for this product. Please cancel it first or manage it from the billing page.',
      });
    }

    const userCredits = await getOrCreateUserCredits(getDb(), userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    let stripePriceId: string;
    try {
      stripePriceId = await ensureStripePriceId(getStripe, plan.planId, billingPeriod);
    } catch (err: unknown) {
      log.credits.error({ err, planId: plan.planId, billingPeriod }, 'Failed to ensure Stripe price for checkout');
      return res.status(500).json({ error: 'Failed to configure plan pricing' });
    }

    const lineItem = { price: stripePriceId, quantity: 1 };

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [lineItem],
      mode: 'subscription',
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, planId: plan.planId, billingPeriod, product: plan.product },
      subscription_data: { metadata: { userId, planId: plan.planId, billingPeriod, product: plan.product } },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating subscription checkout');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create subscription checkout') });
  }
});

router.get('/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const subscription = await findLiveSubscription(getDb(), req.user!.id, product);
    res.json({ subscription: subscription ? serializeSubscription(subscription) : null });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching subscription');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch subscription') });
  }
});

router.post('/subscription/cancel', authenticateToken, async (req: Request, res: Response) => {
  try {
    const subscription = await findLiveSubscription(getDb(), req.user!.id);

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    const updated = await setCancelAtPeriodEnd(getDb(), subscription.id, true);
    if (!updated) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    res.json({ message: 'Subscription will be canceled at end of billing period', subscription: serializeSubscription(updated) });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error canceling subscription');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to cancel subscription') });
  }
});

const changePlanSchema = z.object({
  planId: z.string(),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
});

router.post('/subscription/change-plan', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, billingPeriod } = changePlanSchema.parse(req.body);
    const userId = req.user!.id;

    // Find existing active subscription
    const subscription = await findLiveSubscription(getDb(), userId);

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Find target plan
    const targetPlans = await getPlans({ planId, isActive: true, isFree: false });
    const targetPlan = targetPlans[0];
    if (!targetPlan) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    // Guard: same plan + same billing period
    if (subscription.planId === planId && subscription.billingPeriod === billingPeriod) {
      return res.status(400).json({ error: 'You are already on this plan' });
    }

    // Look up current plan for sortOrder comparison
    const currentPlans = await getPlans({ planId: subscription.planId });
    const currentPlan = currentPlans[0];
    if (!currentPlan) {
      return res.status(500).json({ error: 'Current plan not found' });
    }

    const isUpgrade = targetPlan.sortOrder > currentPlan.sortOrder;
    const isAnnual = billingPeriod === 'annual';

    let targetPriceId: string;
    try {
      targetPriceId = await ensureStripePriceId(getStripe, targetPlan.planId, billingPeriod);
    } catch (err: unknown) {
      log.credits.error({ err, planId: targetPlan.planId, billingPeriod }, 'Failed to ensure Stripe price');
      return res.status(500).json({ error: 'Failed to configure plan pricing' });
    }

    // Retrieve Stripe subscription to get item ID
    const stripeSubscription = await getStripe().subscriptions.retrieve(subscription.stripeSubscriptionId);
    const itemId = stripeSubscription.items.data[0]?.id;
    if (!itemId) {
      return res.status(500).json({ error: 'Could not find subscription item' });
    }

    // If pending cancellation, undo it first
    if (stripeSubscription.cancel_at_period_end) {
      await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    }

    // Update the Stripe subscription
    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{ id: itemId, price: targetPriceId }],
      proration_behavior: isUpgrade ? 'always_invoice' : 'none',
      metadata: {
        ...stripeSubscription.metadata,
        planId: targetPlan.planId,
        billingPeriod,
        product: targetPlan.product,
      },
    });

    // Update the local subscription row. ONE `UPDATE`, because the source's
    // `save()` was one document write: splitting it would open a window where
    // the row names the new plan at the old price.
    const price = isAnnual ? targetPlan.annualPrice : targetPlan.monthlyPrice;
    const updated = await updateSubscriptionPlan(getDb(), subscription.id, {
      planId: targetPlan.planId,
      billingPeriod,
      cancelAtPeriodEnd: false,
      stripePriceId: targetPriceId,
      planPlanId: targetPlan.planId,
      planName: targetPlan.name,
      planProduct: targetPlan.product,
      planCreditsPerMonth: targetPlan.creditsPerMonth,
      planPrice: price,
      planCurrency: targetPlan.currency,
      planBillingPeriod: billingPeriod,
    });
    if (!updated) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    invalidateEntitlementsCache(userId);

    const direction = isUpgrade ? 'upgrade' : 'downgrade';
    log.credits.info({ userId, from: currentPlan.planId, to: targetPlan.planId, direction, billingPeriod }, 'Plan changed');
    res.json({ message: 'Plan changed successfully', subscription: serializeSubscription(updated), direction });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error changing plan');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to change plan') });
  }
});

router.get('/transactions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const db = getDb();
    const transactions = await listTransactionsByUser(db, req.user!.id, {
      limit: Number(limit),
      offset: Number(offset),
    });
    // `count(*)` is bigint, which postgres.js decodes as a STRING while drizzle
    // types it `number`. The repository coerces at that boundary; without it
    // `total` would concatenate rather than add anywhere a client does maths.
    const total = await countTransactionsByUser(db, req.user!.id);
    res.json({ transactions: transactions.map(serializeTransaction), total });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching transactions');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch transactions') });
  }
});

router.post('/portal', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { returnUrl } = req.body;
    const userId = req.user!.id;

    const userCredits = await getOrCreateUserCredits(getDb(), userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error creating portal session');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create billing portal session') });
  }
});

// Entitlements: returns allowed models + feature flags for the current user
router.get('/entitlements', authenticateToken, async (req: Request, res: Response) => {
  try {
    const entitlements = await getUserEntitlements(req.user!.id);
    res.json(entitlements);
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching entitlements');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch entitlements') });
  }
});

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.status(400).send('Missing stripe-signature');

  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) return res.status(500).send('Webhook secret not configured');

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: unknown) {
    log.credits.error({ err }, 'Webhook verification failed');
    return res.status(400).send(`Webhook Error: ${getSafeErrorMessage(err, 'Invalid webhook payload')}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
    }
    res.json({ received: true });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error handling webhook');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to process webhook') });
  }
});

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const metadata = session.metadata;

  // Handle credit purchases
  if (metadata?.type === 'credit_purchase') {
    if (!metadata.userId) return;
    const credits = parseInt(metadata.credits || '0');
    if (credits <= 0) return;

    const db = getDb();
    await getOrCreateUserCredits(db, metadata.userId);

    /*
     * DIVERGENCE, and the only one in this file that changes what a customer's
     * balance does. The two statements have been SWAPPED.
     *
     * The source granted the credits FIRST and inserted the ledger row second,
     * treating error 11000 as "already processed" (`routes/billing.ts:626-648`
     * before this port). Stripe redelivers `checkout.session.completed` as a
     * matter of routine, so on the second delivery that order added the credits
     * AGAIN and only then discovered the duplicate — a double grant that the
     * catch block made look guarded. The subscription path below already had the
     * correct order.
     *
     * Keeping the source order was not an available option either: with
     * `ON CONFLICT ... DO NOTHING RETURNING` there is no exception to catch, so
     * granting first would double-pay and then silently discard the one signal
     * that says so.
     *
     * The insert is the lock. An empty result IS the duplicate, so a dropped
     * connection or a statement timeout still throws and still reaches the
     * caller instead of being answered "already done" — which is what a naive
     * exception-based port does to an infrastructure failure, retiring work
     * nobody performed.
     *
     * The failure this trades into: a crash between the insert and the grant
     * leaves a paying customer un-credited with the dedup row blocking a retry.
     * That is a loud, recoverable, single-customer failure with a ledger row
     * naming it; the one it replaces is a silent recurring overpayment.
     */
    const transaction = await createCreditPurchase(db, {
      oxyUserId: metadata.userId,
      stripeCustomerId: session.customer as string,
      stripePaymentIntentId: session.payment_intent as string,
      amount: session.amount_total || 0,
      currency: session.currency || 'usd',
      credits,
      description: `Purchased ${credits.toLocaleString()} credits`,
    });

    if (!transaction) {
      log.credits.warn({ paymentIntent: session.payment_intent }, 'Duplicate checkout event, skipping');
      return;
    }

    await addCredits(db, metadata.userId, credits, 'paid');
    log.credits.info({ credits, userId: metadata.userId }, 'Added credits to user');
    return;
  }

  // Handle subscription checkouts as fallback (in case customer.subscription.created is delayed)
  if (session.mode === 'subscription' && session.subscription) {
    log.credits.info({ subscriptionId: session.subscription }, 'checkout.session.completed, fetching and syncing');
    const stripeSubscription = await getStripe().subscriptions.retrieve(session.subscription as string);
    await handleSubscriptionUpdate(stripeSubscription);
  }
}

async function handleSubscriptionUpdate(stripeSubscription: Stripe.Subscription) {
  const db = getDb();
  const customerId = stripeSubscription.customer as string;
  const metadata = stripeSubscription.metadata;

  // Find UserCredits by Stripe customer ID, fall back to userId from metadata
  let userCredits = await findUserCreditsByStripeCustomerId(db, customerId);
  if (!userCredits) {
    if (metadata?.userId) {
      log.credits.warn({ customerId, userId: metadata.userId }, 'No UserCredits for stripeCustomerId, falling back to userId');
      userCredits = await getOrCreateUserCredits(db, metadata.userId);
      if (!userCredits.stripeCustomerId) {
        userCredits = (await setStripeCustomerId(db, metadata.userId, customerId)) ?? userCredits;
      }
    } else {
      throw new Error(`No UserCredits found for stripeCustomerId ${customerId} and no userId in metadata`);
    }
  }

  // Match plan by metadata (set via subscription_data.metadata in checkout)
  const planId = metadata?.planId;
  const resolvedPlans = await getPlans({ planId });
  const plan = resolvedPlans[0];
  if (!plan) {
    throw new Error(`Plan not found for subscription ${stripeSubscription.id}, planId: ${planId}`);
  }

  const isAnnual = metadata?.billingPeriod === 'annual';
  const price = isAnnual ? plan.annualPrice : plan.monthlyPrice;

  // Stripe API 2025+: period fields are on subscription items
  const item = stripeSubscription.items.data[0];
  const periodStart = item?.current_period_start;
  const periodEnd = item?.current_period_end;

  // `userCredits.id` is the Oxy user id — this table's primary key IS the user
  // id, exactly as Mongo's `_id` held it, which is what `userCredits._id` read
  // back out at this call site and the two below.
  await upsertSubscriptionFromStripe(db, {
    oxyUserId: userCredits.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSubscription.id,
    stripePriceId: stripeSubscription.items.data[0].price.id,
    status: stripeSubscription.status,
    currentPeriodStart: periodStart ? new Date(periodStart * 1000) : new Date(),
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
    planId: plan.planId,
    billingPeriod: isAnnual ? 'annual' : 'monthly',
    planPlanId: plan.planId,
    planName: plan.name,
    planProduct: plan.product,
    planCreditsPerMonth: plan.creditsPerMonth,
    // `undefined` for a gateway plan with no annual price. `?? null` is
    // deliberate: in Mongo `$set: { price: undefined }` was a NO-OP and stored
    // the field absent, while the same statement in Postgres would need an
    // explicit NULL to mean the same thing.
    planPrice: price ?? null,
    planCurrency: plan.currency,
    planBillingPeriod: isAnnual ? 'annual' : 'monthly',
  });

  // Add subscription credits with dedup protection (no time window — dedup key prevents duplicates)
  if (stripeSubscription.status === 'active') {
    const dedupKey = `${stripeSubscription.id}_${periodStart || Date.now()}`;
    // The ledger row is the lock and goes FIRST, as the source had it here:
    // granting first would make a redelivered webhook pay out twice. A null
    // result means this period was already granted.
    const transaction = await createSubscriptionPayment(db, {
      oxyUserId: userCredits.id,
      stripeCustomerId: customerId,
      // NOT `price ?? 0`, deliberately. `PlanData.annualPrice` is typed `number`
      // but the gateway returns JSON that can omit it, and `transactions.amount`
      // is NOT NULL with no default — so an absent price raises 23502 and the
      // webhook 500s, which is exactly what Mongo did (`amount` is
      // `required: true` and `Transaction.create` runs validators). Defaulting
      // to zero would instead record a $0 payment in the ledger and grant a
      // month of credits against it, silently.
      amount: price,
      currency: plan.currency,
      credits: plan.creditsPerMonth,
      description: `${plan.name} subscription credits (${isAnnual ? 'annual' : 'monthly'})`,
      dedup: dedupKey,
    });

    if (!transaction) {
      log.credits.warn({ dedupKey }, 'Duplicate subscription credit event, skipping');
      // Returns without invalidating the entitlements cache — the source's own
      // early return from the catch block, preserved. It matters for one
      // reachable case: a plan change made in the Stripe portal fires
      // `customer.subscription.updated` with an UNCHANGED `periodStart`, so the
      // dedup key hits, the subscription row above has already been updated, and
      // the cached entitlements stay stale for up to the 5-minute TTL. Flagged
      // rather than fixed here, because widening it is a decision about
      // entitlement freshness and not part of the port.
      return;
    }

    await addCredits(db, userCredits.id, plan.creditsPerMonth, 'paid');
    log.credits.info({ credits: plan.creditsPerMonth, subscriptionId: stripeSubscription.id, periodStart }, 'Added subscription credits');
  }

  invalidateEntitlementsCache(userCredits.id);
}

async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription) {
  const sub = await updateSubscriptionStatus(getDb(), stripeSubscription.id, 'canceled');
  if (sub?.oxyUserId) invalidateEntitlementsCache(sub.oxyUserId);
}

function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subDetails = invoice.parent?.subscription_details;
  if (!subDetails?.subscription) return null;
  return typeof subDetails.subscription === 'string'
    ? subDetails.subscription
    : subDetails.subscription.id;
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  log.credits.info({ subscriptionId }, 'Invoice payment succeeded');
  const stripeSubscription = await getStripe().subscriptions.retrieve(subscriptionId);
  await handleSubscriptionUpdate(stripeSubscription);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  log.credits.error({ subscriptionId, invoiceId: invoice.id }, 'Invoice payment failed');
  await updateSubscriptionStatus(getDb(), subscriptionId, 'past_due');
}

export default router;
