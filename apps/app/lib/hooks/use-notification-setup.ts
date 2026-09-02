/**
 * useNotificationSetup — Push notification registration, foreground handling,
 * tap deep-linking, and real-time Socket.IO notification subscription.
 *
 * Call once in the authenticated app layout.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { io as socketIO } from 'socket.io-client';
import { useRouter } from 'expo-router';
import config from '@/lib/config';
import apiClient from '@/lib/api/client';

// ── Constants ──────────────────────────────────────────────────────
const PROJECT_ID = Constants.expoConfig?.extra?.eas?.projectId;

export function useNotificationSetup() {
  const { user, isAuthenticated, oxyServices } = useOxy();
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokenRef = useRef<string | null>(null);
  const webPushRegisteredRef = useRef(false);

  // ── Foreground notification display (once, native only) ────────
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }, []);

  // ── Push token registration ────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !user?.id || Platform.OS === 'web') return;

    let cancelled = false;

    (async () => {
      try {
        // Android: create notification channel
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'Default',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }

        // Check / request permission
        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted' || cancelled) return;

        // Get Expo push token
        if (!PROJECT_ID) return;
        const { data: token } = await Notifications.getExpoPushTokenAsync({
          projectId: PROJECT_ID,
        });
        if (cancelled || !token || token === tokenRef.current) return;

        tokenRef.current = token;

        // Register with backend
        await apiClient.post('/notifications/push-token', {
          token,
          platform: Platform.OS,
        });
      } catch (_error: unknown) {
        if (!cancelled) tokenRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  // ── Notification tap handler ─────────────────────────────────
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        if (!isAuthenticated) return;
        const pageId = response.notification.request.content.data?.pageId;
        if (typeof pageId === 'string') {
          router.push({ pathname: '/(app)/p/[pageId]', params: { pageId } });
        }
      },
    );

    return () => subscription.remove();
  }, [isAuthenticated, router]);

  // ── Web push registration (browser only) ──────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web' || !isAuthenticated || !user?.id) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (webPushRegisteredRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        // Fetch VAPID public key from backend
        const { data: vapidData } = await apiClient.get('/notifications/vapid-public-key');
        if (cancelled || !vapidData?.publicKey) return;

        // Register service worker
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // Check for existing subscription
        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
          // Request permission
          const permission = await Notification.requestPermission();
          if (cancelled || permission !== 'granted') return;

          // Convert VAPID key from base64url to an ArrayBuffer
          const vapidKey = urlBase64ToArrayBuffer(vapidData.publicKey);

          // Subscribe
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: vapidKey,
          });
        }

        if (cancelled || !subscription) return;

        // Send subscription to backend
        const subJson = subscription.toJSON();
        await apiClient.post('/notifications/web-push-subscription', {
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        });

        if (!cancelled) webPushRegisteredRef.current = true;
      } catch (_error: unknown) {
        if (!cancelled) webPushRegisteredRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  // ── Socket.IO real-time notification subscription ──────────────
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;

    const socket = socketIO(config.apiUrl, {
      auth: (callback) => {
        const token = oxyServices.getAccessToken();
        callback(token ? { token } : {});
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on('notification', () => {
      // Invalidate React Query caches so notification list + unread count refresh
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });

    return () => {
      socket.disconnect();
    };
  }, [isAuthenticated, user?.id, oxyServices, queryClient]);
}

// ── Helpers ──────────────────────────────────────────────────────

/** Convert a base64url-encoded VAPID key to an ArrayBuffer for PushManager.subscribe. */
function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) {
    output[i] = raw.charCodeAt(i);
  }
  return buffer;
}
