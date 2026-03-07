/// <reference types="node" />
import { AccessToken } from 'livekit-server-sdk';

const ROOMS = new Set(['zovid-human', 'zovid-zombie']);

type LiveKitTokenBody = {
  room: string;
  participantIdentity: string;
  participantName?: string;
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!url || !apiKey || !apiSecret) {
      return new Response(
        JSON.stringify({ error: 'LiveKit server not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let body: LiveKitTokenBody;
    try {
      body = (await request.json()) as LiveKitTokenBody;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { room, participantIdentity, participantName } = body;
    if (!room || !participantIdentity) {
      return new Response(
        JSON.stringify({ error: 'room and participantIdentity required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!ROOMS.has(room)) {
      return new Response(JSON.stringify({ error: 'Invalid room' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const at = new AccessToken(apiKey, apiSecret, {
        identity: participantIdentity,
        name: participantName ?? participantIdentity,
      });
      at.addGrant({ roomJoin: true, room });
      const token = await at.toJwt();

      return new Response(
        JSON.stringify({ token, url }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (e) {
      console.error('LiveKit token error:', e);
      return new Response(
        JSON.stringify({ error: 'Failed to create token' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
