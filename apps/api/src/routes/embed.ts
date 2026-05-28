import { Router } from 'express';
import type { Request, Response } from 'express';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { getRedisClient } from '../lib/redis.js';
import { log } from '../lib/logger.js';

const router = Router();

router.use(authenticateToken);

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_SECONDS = 60 * 60 * 6; // 6h

interface PreviewResult {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  source?: string;
}

const previewSchema = z.object({
  url: z.string().url(),
});

function meta(doc: Document, attr: 'property' | 'name', key: string): string | undefined {
  const el = doc.querySelector(`meta[${attr}="${key}" i]`);
  const value = el?.getAttribute('content');
  return value ? value.trim() : undefined;
}

function absoluteUrl(base: string, candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    return new URL(candidate, base).toString();
  } catch {
    return undefined;
  }
}

function detectSource(url: string): string | undefined {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'youtube';
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return 'vimeo';
    if (host.endsWith('loom.com')) return 'loom';
    if (host === 'twitter.com' || host === 'x.com' || host.endsWith('.twitter.com')) return 'twitter';
    if (host.endsWith('figma.com')) return 'figma';
    if (host.endsWith('codepen.io')) return 'codepen';
    if (host === 'gist.github.com') return 'github-gist';
    if (host.endsWith('github.com')) return 'github';
    if (host.endsWith('spotify.com')) return 'spotify';
    if (host.endsWith('soundcloud.com')) return 'soundcloud';
    return undefined;
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(url: string): Promise<{ body: string; finalUrl: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; OxySpaceBot/1.0; +https://space.oxy.so/bot)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    let received = 0;
    const decoder = new TextDecoder();
    let body = '';
    while (received < MAX_HTML_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      body += decoder.decode(value, { stream: true });
      if (received >= MAX_HTML_BYTES) break;
    }
    body += decoder.decode();
    try {
      await reader.cancel();
    } catch {
      // ignored — best effort
    }
    return { body, finalUrl: res.url || url };
  } catch (error: unknown) {
    log.general.warn({ err: error, url }, 'embed preview fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseOpenGraph(html: string, finalUrl: string): PreviewResult {
  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  const title =
    meta(doc, 'property', 'og:title') ||
    meta(doc, 'name', 'twitter:title') ||
    doc.querySelector('title')?.textContent?.trim();

  const description =
    meta(doc, 'property', 'og:description') ||
    meta(doc, 'name', 'twitter:description') ||
    meta(doc, 'name', 'description');

  const rawImage =
    meta(doc, 'property', 'og:image:secure_url') ||
    meta(doc, 'property', 'og:image') ||
    meta(doc, 'name', 'twitter:image') ||
    meta(doc, 'name', 'twitter:image:src');

  const iconHref =
    doc
      .querySelector('link[rel~="icon" i][href], link[rel="shortcut icon" i][href], link[rel="apple-touch-icon" i][href]')
      ?.getAttribute('href') || undefined;

  const fallbackFavicon = `${new URL(finalUrl).origin}/favicon.ico`;

  return {
    url: finalUrl,
    title: title || undefined,
    description: description || undefined,
    image: absoluteUrl(finalUrl, rawImage || undefined),
    favicon: absoluteUrl(finalUrl, iconHref) || fallbackFavicon,
    source: detectSource(finalUrl),
  };
}

const inMemoryCache = new Map<string, { value: PreviewResult; expiresAt: number }>();
const INMEM_CACHE_MAX = 256;

function cacheKey(url: string): string {
  return `embed:preview:${url}`;
}

async function readCache(url: string): Promise<PreviewResult | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(cacheKey(url));
      if (raw) return JSON.parse(raw) as PreviewResult;
    } catch (error) {
      log.general.warn({ err: error }, 'embed preview redis read failed');
    }
  }
  const entry = inMemoryCache.get(url);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  if (entry) inMemoryCache.delete(url);
  return null;
}

async function writeCache(url: string, value: PreviewResult): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(cacheKey(url), JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
      return;
    } catch (error) {
      log.general.warn({ err: error }, 'embed preview redis write failed');
    }
  }
  inMemoryCache.set(url, {
    value,
    expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
  });
  if (inMemoryCache.size > INMEM_CACHE_MAX) {
    const oldest = inMemoryCache.keys().next().value;
    if (oldest) inMemoryCache.delete(oldest);
  }
}

/**
 * POST /embed/preview
 * Body:  { url: string }
 * Reply: { title?, description?, image?, favicon?, source?, url }
 *
 * Results are cached in Redis (preferred) or in-memory for 6h. Fetch is
 * size-capped and timeout-bounded; never throws on remote failure — returns
 * the best partial result it managed to gather instead.
 */
router.post('/preview', async (req: Request, res: Response) => {
  try {
    const body = previewSchema.parse(req.body);
    const cached = await readCache(body.url);
    if (cached) {
      res.json(cached);
      return;
    }
    const fetched = await fetchWithTimeout(body.url);
    if (!fetched) {
      const fallback: PreviewResult = {
        url: body.url,
        source: detectSource(body.url),
      };
      res.json(fallback);
      return;
    }
    const parsed = parseOpenGraph(fetched.body, fetched.finalUrl);
    await writeCache(body.url, parsed);
    res.json(parsed);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid input', details: error.errors });
      return;
    }
    log.general.error({ err: error }, 'Failed to build embed preview');
    res.status(500).json({ error: 'Failed to build embed preview' });
  }
});

export default router;
