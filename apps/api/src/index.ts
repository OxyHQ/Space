import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDB } from './lib/db.js';
import { log } from './lib/logger.js';
import { isAbortError, isFatalError, isTransientNetworkError } from './lib/error-classification.js';

// Routes
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import conversationsRouter from './routes/conversations.js';
import chatRouter from './routes/chat.js';
import creditsRouter from './routes/credits.js';
import v1Router from './routes/v1.js';
import billingRouter from './routes/billing.js';
import feedbackRouter from './routes/feedback.js';
import modelsStatsRouter from './routes/models-stats.js';
import internalRouter from './routes/internal.js';
import analyticsRouter from './routes/analytics.js';
import webhooksRouter from './routes/webhooks.js';
import notificationsRouter from './routes/notifications.js';
import workspacesRouter from './routes/workspaces.js';
import shareLinksRouter from './routes/share-links.js';
import pagesRouter from './routes/pages.js';
import blocksRouter from './routes/blocks.js';

// Register hooks (side-effect import)
import './lib/hooks/index.js';
import { warmupProviders } from './lib/provider-warmup.js';
// Socket.io
import { initSocket } from './socket.js';

// Fix for ES Modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the api directory (not the monorepo root)
dotenv.config({ path: join(__dirname, '../.env') });

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Create HTTP server with optimized settings for streaming
const server = http.createServer({
  // Increase max header size for long authentication tokens
  maxHeaderSize: 16384,
  // Keep connections alive for SSE
  keepAlive: true,
  keepAliveTimeout: 65000, // Slightly higher than default
}, app);

// Handle HTTP server errors (e.g. EADDRINUSE)
server.on('error', (error: NodeJS.ErrnoException) => {
  log.general.error({ err: error }, '[Server] HTTP server error');
  if (error.code === 'EADDRINUSE') {
    log.general.error({ port: PORT }, 'Port already in use');
    process.exit(1);
  }
});

// Optimize server for SSE streaming
server.on('connection', (socket) => {
  // Disable Nagle's algorithm for all connections to reduce latency
  socket.setNoDelay(true);
  // Set keep-alive
  socket.setKeepAlive(true, 60000);
});

initSocket(server);

// Public API routes (/v1) - allow all origins (like OpenAI's API)
app.use('/v1', cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info'],
  optionsSuccessStatus: 200
}));

// Disable nginx/proxy buffering for /v1 SSE streaming responses
app.use('/v1', (_req, res, next) => {
  res.setHeader('X-Accel-Buffering', 'no');
  next();
});

// Internal routes - restricted to known origins
const PRODUCTION_ORIGINS = [
  'https://space.oxy.so',
  'https://console.space.oxy.so',
  'https://gateway.space.oxy.so',
];

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
  'exp://localhost:8081',
  'http://10.0.2.2:8081',
];

const allowedOrigins = [
  ...(process.env.WEB_URL ? [process.env.WEB_URL] : []),
  ...PRODUCTION_ORIGINS,
  ...DEV_ORIGINS,
];

// Internal routes CORS - skip /v1 routes (they have their own permissive CORS above)
app.use((req, res, next) => {
  if (req.path.startsWith('/v1')) return next();
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info', 'X-Oxy-User-Id', 'X-Workspace-Id'],
    optionsSuccessStatus: 200,
  })(req, res, next);
});

// Allow cross-origin resource loading (fixes ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// Stripe webhook needs raw body for signature verification
app.use('/billing/webhook', express.raw({ type: 'application/json' }));

// Increase body size limit for large chat contexts
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Optimize SSE routes for real-time streaming
app.use('/clarity/search', (_req, res, next) => {
  // Disable all buffering for SSE
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Disable Nagle's algorithm for lower latency
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0); // No timeout for SSE connections
  }

  next();
});

// Routes
app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/conversations', conversationsRouter);
app.use('/credits', creditsRouter);
app.use('/clarity/search', chatRouter);
app.use('/v1', v1Router);
app.use('/billing', billingRouter);
app.use('/feedback', feedbackRouter);
app.use('/models', modelsStatsRouter);
app.use('/analytics', analyticsRouter);
app.use('/webhooks', webhooksRouter);
app.use('/notifications', notificationsRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/pages', pagesRouter);
app.use('/api', shareLinksRouter);
app.use('/api', blocksRouter);
app.use('/internal', internalRouter);

// Root route
app.get('/', (_req, res) => {
  res.json({
    message: 'Oxy Space API',
    version: '1.0.0',
    endpoints: [
      '/health',
      '/auth',
      '/conversations',
      '/credits',
      '/clarity/search',
      '/v1',
      '/billing',
      '/feedback',
      '/models',
      '/analytics',
      '/webhooks',
      '/notifications',
      '/api/workspaces',
      '/api/pages',
      '/api/blocks',
      '/api/share',
      '/internal',
    ]
  });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.general.error({ err }, 'Unhandled Express error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something went wrong!' });
  }
});

// Process-level error handlers — prevent crashes from taking down all users
// Classifies errors to determine logging level (inspired by openclaw)
process.on('unhandledRejection', (reason) => {
  // AbortError: intentional cancellation (user stopped request) — suppress
  if (isAbortError(reason)) return;

  // Fatal: OOM, worker failures — must exit
  if (isFatalError(reason)) {
    log.general.error({ err: reason }, '[Process] FATAL unhandled rejection — shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }

  // Transient network: ECONNRESET, ETIMEDOUT, etc. — expected with external providers
  if (isTransientNetworkError(reason)) {
    log.general.warn({ err: reason }, '[Process] Transient network error (continuing)');
    return;
  }

  // Everything else: log as error but keep running
  log.general.error({ reason: reason instanceof Error ? reason : String(reason) }, '[Process] Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  log.general.error({ err: error }, '[Process] Uncaught exception — shutting down');
  setTimeout(() => process.exit(1), 5000).unref();
});

// Connect to MongoDB before starting the server
connectDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      log.general.info({ port: PORT }, 'API server listening');
      // Pre-warm TLS connections to AI providers (non-blocking)
      warmupProviders().catch((err) => log.general.error({ err }, '[Warmup] Provider warmup error'));
      // Verify Redis connectivity (non-blocking)
      import('./lib/redis.js').then(({ getRedisClient }) => {
        const redis = getRedisClient();
        if (redis) {
          redis.ping()
            .then(() => log.general.info('Redis readiness check passed'))
            .catch((err) => log.general.warn({ err }, 'Redis readiness check failed — rate limiting will fail-open'));
        } else {
          log.general.info('Redis not configured (REDIS_URL not set) — rate limiting disabled');
        }
      });
    });

    // Graceful shutdown handler
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.general.info(`Received ${signal}. Starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        log.general.info('HTTP server closed (no new connections)');
      });

      // Give in-flight requests 30 seconds to complete (agent sessions can be long)
      const forceTimeout = setTimeout(() => {
        log.general.error('Force exit after 30s grace period');
        process.exit(1);
      }, 30_000);
      forceTimeout.unref();

      try {
        // Close Socket.IO connections
        const { getIO } = await import('./socket.js');
        const io = getIO();
        if (io) {
          await new Promise<void>((resolve) => io.close(() => resolve()));
          log.general.info('Socket.IO closed');
        }

        // Close Redis connections
        const { closeRedis } = await import('./lib/redis.js');
        await closeRedis();
        log.general.info('Redis connections closed');

        // Close MongoDB connection
        const mongoose = await import('mongoose');
        await mongoose.default.connection.close();
        log.general.info('MongoDB connection closed');

        clearTimeout(forceTimeout);
        log.general.info('Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        log.general.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  });
