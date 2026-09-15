import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerToClientEvent, AudioClientMessage, AudioServerMessage } from '@rfutils/shared';
import { createApiRouter } from './routes.js';
import { MonitorService, type AudioFrame } from './monitor/index.js';
import { collectDiagnostics, init as initDiag, say } from './diag/index.js';

// Before anything that can fail, so a failure during startup is logged and
// captured like any other.
initDiag({
  app: 'rfutils',
  envPrefix: 'RFUTILS',
  version: '0.2.0',
});

if (process.argv.includes('--collect-diagnostics')) {
  // stdout, so it can be used in a script; logging went to stderr.
  say.info(collectDiagnostics());
  process.exit(0);
}

const PORT = Number(process.env.RFUTILS_SERVER_PORT ?? process.env.PORT ?? 8420);
const HOST = process.env.RFUTILS_HOST ?? '0.0.0.0';
const ENABLE_MONITOR = process.env.RFUTILS_DISABLE_MONITOR !== '1';

const monitor = new MonitorService();

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', createApiRouter(monitor));

// Serve the built web UI in production (dev uses Vite's own server + proxy).
// Express 5 requires the catch-all to be a named wildcard — a bare '*' throws
// from path-to-regexp at startup, and this branch only runs when web/dist
// exists, which is exactly the packaged app and never `npm run dev`. The
// fallback is sent relative to `root` so that a dot-directory anywhere in the
// install path (send refuses those by default) can't turn deep links into 404s.
const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('/{*splat}', (_req, res) => res.sendFile('index.html', { root: webDist }));
}

const server = http.createServer(app);

// Two WebSocket endpoints share one HTTP server, so route upgrades by path
// ourselves (noServer) — passing {server, path} to multiple WebSocketServers
// makes each reject the other's upgrades with a 400.
const wss = new WebSocketServer({ noServer: true });
function broadcast(event: ServerToClientEvent): void {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}
monitor.on('event', broadcast);

wss.on('connection', (socket) => {
  // Send the current device snapshot immediately on connect.
  socket.send(JSON.stringify({ type: 'devices-snapshot', devices: monitor.snapshot() } satisfies ServerToClientEvent));
});

// Audio cue: a separate binary WebSocket so PCM frames don't contend with the
// device-state channel. One channel cued per socket; server relays PCM16 mono.
const MAX_AUDIO_BACKLOG = 1 << 20; // 1 MB: drop frames rather than buffer unbounded
const audioWss = new WebSocketServer({ noServer: true });
audioWss.on('connection', (socket) => {
  let cued: string | null = null; // requested channelId (for stopCue)
  let streamId: string | null = null; // internal channelId whose frames we relay

  const onAudio = (frame: AudioFrame): void => {
    if (frame.channelId !== streamId) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_AUDIO_BACKLOG) return; // client can't keep up; drop
    socket.send(frame.pcm);
  };
  monitor.on('audio', onAudio);

  const send = (msg: AudioServerMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary) return; // clients don't send audio
    // A text frame arrives as a Buffer (default nodebuffer binaryType).
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : (data as Buffer).toString('utf8');
    let msg: AudioClientMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'cue') {
      const requested = msg.channelId;
      if (cued === requested) return; // already cued/cueing this channel — no double count
      // Claim synchronously and stop the previous cue now — startCue()'s
      // ref-count increment is synchronous, so this stays balanced even when
      // cues arrive faster than startCue() resolves.
      const previous = cued;
      cued = requested;
      streamId = null; // no frames until the format handshake for THIS cue
      if (previous) monitor.stopCue(previous);
      void monitor
        .startCue(requested)
        .then((format) => {
          if (cued !== requested) return; // superseded by a newer cue/stop; it already reconciled
          if (!format) {
            cued = null;
            streamId = null;
            send({ type: 'audio-error', channelId: requested, message: 'Channel is not cueable (in direct AES67 mode only live AES67 channels carry audio).' });
            return;
          }
          streamId = format.streamChannelId;
          send({ type: 'audio-format', channelId: requested, sampleRate: format.sampleRate, channels: 1, encoding: 'pcm16' });
        })
        .catch((e) => send({ type: 'audio-error', channelId: requested, message: (e as Error).message }));
    } else if (msg.type === 'stop') {
      if (cued) monitor.stopCue(cued);
      cued = null;
      streamId = null;
    }
  });

  const cleanup = (): void => {
    monitor.off('audio', onAudio);
    if (cued) monitor.stopCue(cued);
    cued = null;
    streamId = null;
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

// Route WebSocket upgrades by path to the right server.
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/ws/audio') {
    audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  say.info(`[rfutils] server listening on http://${HOST}:${PORT}`);
  if (ENABLE_MONITOR) {
    monitor.start();
    say.info('[rfutils] device discovery started (mDNS / Shure / AES67)');
  } else {
    say.info('[rfutils] device discovery disabled (RFUTILS_DISABLE_MONITOR=1)');
  }
});

function shutdown(): void {
  say.info('[rfutils] shutting down');
  monitor.stop();
  wss.close();
  audioWss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
