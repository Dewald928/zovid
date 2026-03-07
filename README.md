# Zovid

The massive zombie plague survival game. Multiplayer game state and positions are synced via SpacetimeDB; proximity voice chat uses a self-hosted LiveKit server. The chat application is a simple chat room where users can send messages to each other. The chat application uses SpacetimeDB to store the chat messages.

It is based directly on the plain React + TypeScript + Vite template. You can follow the quickstart guide for how creating this project from scratch at [SpacetimeDB TypeScript Quickstart](https://spacetimedb.com/docs/sdks/typescript/quickstart).

## Proximity voice chat (self-hosted LiveKit)

Humans hear nearby humans; zombies hear nearby zombies. Voice is handled by a **self-hosted LiveKit** server (no paid third-party service). The Vercel deployment only issues short-lived tokens via `POST /api/livekit-token`.

### 1. Self-host LiveKit

Run LiveKit yourself (e.g. on a VPS) using Docker:

```bash
docker run --rm -p 7880:7880 -p 7881:7881 -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server --dev
```

For production you need a config file with `port`, `rtc.port_range_start`/`port_range_end`, and `keys` (API key and secret). Put a reverse proxy (Caddy, Nginx) in front with TLS and proxy WebSocket to LiveKit’s port. See [LiveKit self-hosting](https://docs.livekit.io/transport/self-hosting/deployment/). Optionally run a TURN server (e.g. Coturn) for users behind strict NATs.

### 2. Vercel environment variables

In your Vercel project settings, set:

- `LIVEKIT_URL` – Your LiveKit server URL (e.g. `wss://voice.yourdomain.com`).
- `LIVEKIT_API_KEY` – API key from your LiveKit config.
- `LIVEKIT_API_SECRET` – API secret from your LiveKit config.

The token API uses these to sign tokens; no media runs on Vercel.

### 3. Optional frontend env

- `VITE_APP_URL` – Base URL for the app (e.g. `https://your-app.vercel.app`). If unset, the client uses `window.location.origin` for the token request (fine when the app and API share the same origin).

### Testing locally

1. **Start LiveKit** (Docker, dev mode with fixed key/secret):

   ```bash
   docker run --rm -p 7880:7880 -p 7881:7881 -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server --dev
   ```

2. **Env for the token API** – create `.env.local` (or set in shell) so the API can issue tokens:

   ```bash
   LIVEKIT_URL=ws://localhost:7880
   LIVEKIT_API_KEY=devkey
   LIVEKIT_API_SECRET=secret
   ```

3. **Run the app and API together** – plain `npm run dev` (Vite) does not serve `/api/livekit-token`. Use the Vercel CLI so the app and serverless function run on one origin:

   ```bash
   npx vercel dev
   ```

   Open the URL it prints (e.g. `http://localhost:3000`). Use HTTPS in production; for localhost most browsers allow microphone on `http://localhost`.

4. **Test with two clients** – open two browser windows (or one normal + one incognito), join the game in both, start a round, and move the two players close together in the same team (both human or both zombie). You should hear the other when in range (~500 units).

### Voice toggle and debugging

- **Toggle** – Use the small mic icon next to your player name to turn voice chat on or off (state is stored in `localStorage`).
- **No sound?** – Open DevTools (F12) → Console. Then either: **(1)** In the **address bar**, add `?voice_debug=1` to the page URL (e.g. `http://localhost:3000/?voice_debug=1`) and press Enter; or **(2)** In the **console**, run `window.__ZOVID_VOICE_DEBUG = true` and reload the page. You’ll see periodic logs:
  - **Recording**: `micEnabled`, `hasAudioPublication` – confirms the mic is captured and published.
  - **Transmission**: `connectionState` (should be `connected`), `remoteCount` – confirms you’re in the room and see others.
  - **Playback**: for each remote, `distance`, `volume`, `hasAudioTrack` – if `volume` is 0 or `hasAudioTrack` is false, you won’t hear them; move closer (under 500 units) or check that the other client has voice on and mic allowed.

### Optimising LiveKit usage (keep costs low)

The app is already tuned to reduce bandwidth and CPU:

- **Connect only when needed** – Voice connects only when the round is active and the user has voice enabled; it disconnects when the round ends or voice is turned off.
- **DTX** – Discontinuous transmission: no audio packets are sent when you’re silent, cutting bandwidth and server work.
- **Speech preset** – Audio is published with the speech preset (lower bitrate than music).
- **Mono, no RED** – Mono audio and redundant encoding disabled to save a bit more bandwidth (trade-off: slightly less resilience to packet loss).
- **Noise suppression / AGC / echo cancellation** – Cleaner capture so the encoder can work efficiently.

If you self-host, you can also: run a single region close to your players, size the instance for your peak concurrency, and use the LiveKit dashboard or metrics to watch participant minutes and bandwidth.

---

You can follow the instructions for creating your own SpacetimeDB module here: [SpacetimeDB Rust Module Quickstart](https://spacetimedb.com/docs/modules/rust/quickstart). Place the module in the `quickstart-chat/server` directory for compability with this project.

In order to run this example, you need to:

- `pnpm build` in the root directory (`spacetimedb-typescriptsdk`)
- `pnpm install` in this directory
- `pnpm build` in this directory
- `pnpm dev` in this directory to run the example

Below is copied from the original template README:

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
});
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react';

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
});
```
