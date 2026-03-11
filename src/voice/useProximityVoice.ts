import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, AudioPresets } from 'livekit-client';
import type { RemoteTrack } from 'livekit-client';
import type { Identity } from 'spacetimedb';
import type { Player } from '../module_bindings/types';
import { fetchLiveKitToken } from './fetchLiveKitToken';
import { getGameState } from '../game/stdbBridge';

const VOICE_RADIUS = 500;
const PROXIMITY_UPDATE_MS = 200;
const VOICE_DEBUG_INTERVAL_MS = 3000;

function identityHex(playerIdentity: { toHexString: () => string }): string {
  return playerIdentity.toHexString().replace(/^0x/, '').toLowerCase();
}

function isVoiceDebug(): boolean {
  if (typeof window === 'undefined') return false;
  const u = new URL(window.location.href);
  if (u.searchParams.get('voice_debug') === '1') return true;
  return !!(window as unknown as { __ZOVID_VOICE_DEBUG?: boolean }).__ZOVID_VOICE_DEBUG;
}

export interface UseProximityVoiceParams {
  enabled: boolean;
  identity: Identity | null;
  isZombie: boolean;
  players: Player[];
  roundActive: boolean;
  roomId?: bigint;
}

/**
 * Joins the team LiveKit room (zovid-human or zovid-zombie), publishes mic,
 * and sets remote participants' volume by distance using SpacetimeDB positions.
 * Returns startAudio() - call it on a user gesture (e.g. when enabling voice) to unblock playback.
 */
export function useProximityVoice({
  enabled,
  identity,
  isZombie,
  players,
  roundActive,
  roomId = 0n,
}: UseProximityVoiceParams): { startAudio: () => void } {
  const roomRef = useRef<Room | null>(null);
  const targetRoomRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);

  const startAudio = useCallback(() => {
    roomRef.current?.startAudio?.();
  }, []);

  // Join the correct team room when enabled and we have identity (room-scoped: zovid-{roomId}-human/zombie)
  useEffect(() => {
    if (!enabled || !identity || !roundActive || roomId === 0n) {
      targetRoomRef.current = null;
      setConnected(false);
      return;
    }

    const roomName = isZombie ? `zovid-${roomId}-zombie` : `zovid-${roomId}-human`;
    targetRoomRef.current = roomName;

    const participantIdentity = identity.toHexString();
    const localPlayer = players.find(
      (p) => p.identity.toHexString() === participantIdentity
    );
    const participantName = localPlayer?.name ?? 'Player';

    let cancelled = false;
    const room = new Room({
      audioCaptureDefaults: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
      publishDefaults: {
        dtx: true,
        audioPreset: AudioPresets.speech,
        red: false,
        forceStereo: false,
      },
    });

    const debug = isVoiceDebug();

    fetchLiveKitToken({
      room: roomName,
      participantIdentity,
      participantName,
    })
      .then(({ url, token }) => {
        if (cancelled) return;
        if (debug) console.log('[Voice] Token received, connecting to', url);
        return room.connect(url, token);
      })
      .then(() => {
        if (cancelled) return;
        roomRef.current = room;
        room.localParticipant.setMicrophoneEnabled(true);
        setConnected(true);

        // Attach remote audio tracks to an element so they actually play (SDK may not auto-attach in all browsers)
        const onTrackSubscribed = (track: RemoteTrack) => {
          if (track.kind !== 'audio') return;
          const el = track.attach();
          el.style.display = 'none';
          el.setAttribute('data-livekit-remote-audio', '1');
          document.body.appendChild(el);
          el.play().catch(() => {});
        };
        const onTrackUnsubscribed = (track: RemoteTrack) => {
          track.detach().forEach((e) => e.remove());
        };
        room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
        room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);

        // Unblock audio playback (browsers require user gesture; we also trigger from voice toggle click)
        room.startAudio().catch(() => {});
        if (debug) {
          const audioPubs = Array.from(room.localParticipant.audioTrackPublications.values());
          const pub = audioPubs[0];
          console.log('[Voice] Connected. Recording:', {
            micEnabled: room.localParticipant.isMicrophoneEnabled,
            audioPublication: pub ? { trackSid: pub.trackSid, muted: pub.isMuted } : 'none',
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[Voice] Connect failed:', err);
        }
        setConnected(false);
        room.disconnect();
      });

    return () => {
      cancelled = true;
      room.removeAllListeners();
      room.remoteParticipants.forEach((p) => {
        p.audioTrackPublications.forEach((pub) => {
          if (pub.track) pub.track.detach().forEach((e) => e.remove());
        });
      });
      roomRef.current = null;
      setConnected(false);
      room.disconnect();
    };
  }, [enabled, identity?.toHexString(), isZombie, roundActive, roomId]);

  // Proximity volume loop: set each remote participant's volume by distance.
  // Depends on `connected` so the interval starts only after room.connect() completes
  // (roomRef.current is set in the connect callback; without this the effect ran too early and never started the interval).
  useEffect(() => {
    if (!enabled || !connected || !roomRef.current) return;

    const interval = setInterval(() => {
      const room = roomRef.current;
      if (!room) return;

      const state = getGameState();
      const localHexNorm = room.localParticipant.identity.replace(/^0x/, '').toLowerCase();
      const localPlayer = state.players.find(
        (p) => identityHex(p.identity) === localHexNorm
      );

      if (!localPlayer) return;

      const lx = localPlayer.x;
      const ly = localPlayer.y;

      room.remoteParticipants.forEach((participant) => {
        const remoteHexNorm = participant.identity.replace(/^0x/, '').toLowerCase();
        const remotePlayer = state.players.find(
          (p) => identityHex(p.identity) === remoteHexNorm
        );
        if (!remotePlayer) {
          participant.setVolume(0);
          return;
        }
        const dx = remotePlayer.x - lx;
        const dy = remotePlayer.y - ly;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= VOICE_RADIUS) {
          participant.setVolume(0);
          return;
        }
        const t = d / VOICE_RADIUS;
        const volume = Math.max(0, 1 - t * 0.8);
        participant.setVolume(volume);
      });
    }, PROXIMITY_UPDATE_MS);

    return () => clearInterval(interval);
  }, [enabled, connected]);

  // Debug: periodic log of connection, recording, and playback state
  useEffect(() => {
    if (!enabled || !isVoiceDebug()) return;

    const log = () => {
      const room = roomRef.current;
      if (!room) {
        console.log('[Voice] Room: not connected');
        return;
      }
      const state = getGameState();
      const localHexNorm = room.localParticipant.identity.replace(/^0x/, '').toLowerCase();
      const localPlayer = state.players.find(
        (p) => identityHex(p.identity) === localHexNorm
      );
      const remotes: Array<{ identity: string; distance: number; volume: number; hasAudioTrack: boolean }> = [];
      room.remoteParticipants.forEach((p) => {
        const remoteHexNorm = p.identity.replace(/^0x/, '').toLowerCase();
        const rp = state.players.find((x) => identityHex(x.identity) === remoteHexNorm);
        const dx = rp ? rp.x - (localPlayer?.x ?? 0) : 0;
        const dy = rp ? rp.y - (localPlayer?.y ?? 0) : 0;
        const d = Math.sqrt(dx * dx + dy * dy);
        const vol = p.getVolume() ?? -1;
        const hasAudio = Array.from(p.audioTrackPublications.values()).some((pub) => pub.track);
        remotes.push({ identity: p.identity.slice(0, 8), distance: Math.round(d), volume: vol, hasAudioTrack: hasAudio });
      });

      console.log('[Voice] Debug', {
        connectionState: room.state,
        recording: {
          micEnabled: room.localParticipant.isMicrophoneEnabled,
          hasAudioPublication: room.localParticipant.audioTrackPublications.size > 0,
        },
        remoteCount: room.remoteParticipants.size,
        remotes,
      });
    };

    log();
    const id = setInterval(log, VOICE_DEBUG_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  return { startAudio };
}
