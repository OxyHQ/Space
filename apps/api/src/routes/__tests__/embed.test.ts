import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

// Mirror the parse function from routes/embed.ts so we can exercise it
// without spinning up the Express app. The implementations stay aligned —
// any change to embed.ts should be reflected here.

function meta(doc: Document, attr: 'property' | 'name', key: string): string | undefined {
  const el = doc.querySelector(`meta[${attr}="${key}" i]`);
  return el?.getAttribute('content')?.trim() || undefined;
}

function detectSource(url: string): string | undefined {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'youtube';
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return 'vimeo';
    return undefined;
  } catch {
    return undefined;
  }
}

function parseOpenGraphLite(html: string, finalUrl: string) {
  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;
  return {
    title: meta(doc, 'property', 'og:title') || doc.querySelector('title')?.textContent?.trim(),
    description: meta(doc, 'property', 'og:description') || meta(doc, 'name', 'description'),
    image: meta(doc, 'property', 'og:image'),
    source: detectSource(finalUrl),
  };
}

describe('embed parser', () => {
  it('extracts OG metadata', () => {
    const html = `<!doctype html><html><head>
      <title>Hello</title>
      <meta property="og:title" content="Hello World"/>
      <meta property="og:description" content="A great page"/>
      <meta property="og:image" content="https://example.com/img.png"/>
    </head></html>`;
    const result = parseOpenGraphLite(html, 'https://example.com/page');
    expect(result.title).toBe('Hello World');
    expect(result.description).toBe('A great page');
    expect(result.image).toBe('https://example.com/img.png');
  });

  it('falls back to <title> when og:title is missing', () => {
    const html = `<!doctype html><html><head><title>Plain title</title></head></html>`;
    const result = parseOpenGraphLite(html, 'https://example.com/page');
    expect(result.title).toBe('Plain title');
  });

  it('detects YouTube source from URL', () => {
    expect(detectSource('https://youtu.be/abc')).toBe('youtube');
    expect(detectSource('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectSource('https://example.com')).toBeUndefined();
  });
});
