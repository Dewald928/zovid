/**
 * Fetches a short-lived LiveKit token from the app's token API (e.g. Vercel serverless).
 * Uses same origin when possible so no CORS or extra env is required.
 */
const API_PATH = '/api/livekit-token';

export interface LiveKitTokenParams {
  /** Room name, e.g. zovid-1-human, zovid-1-zombie (room-scoped for multi-lobby voice) */
  room: string;
  participantIdentity: string;
  participantName?: string;
}

export interface LiveKitTokenResult {
  token: string;
  url: string;
}

export async function fetchLiveKitToken(
  params: LiveKitTokenParams
): Promise<LiveKitTokenResult> {
  const base =
    typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_URL
      ? (import.meta.env.VITE_APP_URL as string).replace(/\/$/, '')
      : (typeof window !== 'undefined' ? window.location.origin : '');

  const url = `${base}${API_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Failed to get voice token');
  }

  const data = (await res.json()) as LiveKitTokenResult;
  if (!data.token || !data.url) {
    throw new Error('Invalid token response');
  }
  return data;
}
