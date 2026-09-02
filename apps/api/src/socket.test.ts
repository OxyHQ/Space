import { Buffer } from 'node:buffer';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as SocketServer } from 'socket.io';
import { initSocket } from './socket.js';

const originalFetch = globalThis.fetch;
const clients: ClientSocket[] = [];
let httpServer: http.Server;
let socketServer: SocketServer;
let origin: string;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.test-signature`;
}

function openClient(options: {
  auth?: Record<string, string>;
  query?: Record<string, string>;
}): ClientSocket {
  const client = connectSocket(origin, {
    ...options,
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });
  clients.push(client);
  return client;
}

function waitForConnect(client: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connect timed out')), 3_000);
    client.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForConnectError(client: ClientSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket auth failure timed out')), 3_000);
    client.once('connect', () => {
      clearTimeout(timeout);
      reject(new Error('Socket connected despite failed authentication'));
    });
    client.once('connect_error', (error: Error) => {
      clearTimeout(timeout);
      resolve(error);
    });
  });
}

beforeEach(async () => {
  httpServer = http.createServer();
  socketServer = initSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) client.close();
  await new Promise<void>((resolve) => socketServer.close(() => resolve()));
});

describe('notification socket identity', () => {
  it('joins only the room from the server-validated Oxy session', async () => {
    globalThis.fetch = async () =>
      jsonResponse({
        valid: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
        lastActivity: '2026-09-02T00:00:00.000Z',
        user: { id: 'validated-user', username: 'valid', publicKey: 'pub_valid' },
      });

    const client = openClient({
      auth: {
        token: createJwt({
          userId: 'validated-user',
          sessionId: 'session-valid',
          exp: 4_102_444_800,
        }),
        userId: 'spoofed-user',
      },
      query: { userId: 'spoofed-user' },
    });

    await waitForConnect(client);
    client.emit('subscribe-notifications', { userId: 'spoofed-user' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const connected = await socketServer.fetchSockets();
    expect(connected).toHaveLength(1);
    expect(connected[0]?.rooms.has('user:validated-user')).toBe(true);
    expect(connected[0]?.rooms.has('user:spoofed-user')).toBe(false);
  });

  it('does not establish a server connection when Oxy rejects the session', async () => {
    globalThis.fetch = async () => jsonResponse({ valid: false });
    let connectionCount = 0;
    socketServer.on('connection', () => {
      connectionCount += 1;
    });

    const client = openClient({
      auth: {
        token: createJwt({
          userId: 'claimed-user',
          sessionId: 'invalid-session',
          exp: 4_102_444_800,
        }),
      },
    });

    await expect(waitForConnectError(client)).resolves.toMatchObject({
      message: 'Session validation failed',
    });
    expect(connectionCount).toBe(0);
    expect(await socketServer.fetchSockets()).toHaveLength(0);
  });
});
