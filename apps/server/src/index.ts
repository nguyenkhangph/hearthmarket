import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { NPCS, NPC_DEFS, SyntheticWorld, setContractAccount, type Action, type NpcId, type WorldDay, type WorldSource } from '@hearth/economy';
import { config } from './config.ts';
import { Game } from './game.ts';
import { NpcBrain } from './brain/brain.ts';
import { OpenAiCompatible, WithFallback } from './brain/llm.ts';
import { MockChain, NpcSigner, type ChainAdapter } from './chain/signer.ts';
import { NearChain } from './chain/near.ts';
import { OpenMeteoWorld } from './world/openMeteo.ts';

setContractAccount(config.near.contract);
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- world
const replayDays = (JSON.parse(readFileSync(join(root, config.worldReplayFile), 'utf8')) as { days: WorldDay[] }).days;
let world: WorldSource | undefined;
if (config.worldSource === 'open-meteo') {
  const om = new OpenMeteoWorld(replayDays[0], (e) => log('open-meteo error, keeping last value:', e.message));
  await om.start();
  world = om;
} else if (config.worldSource === 'synthetic') {
  world = new SyntheticWorld(config.seed);
}

// ---------------------------------------------------------------- brain
const { primary, fallback } = config.llm;
const llm = config.brain === 'llm' && primary.baseUrl
  ? new WithFallback(new OpenAiCompatible(primary), fallback.baseUrl ? new OpenAiCompatible(fallback) : undefined)
  : null;
const brain = new NpcBrain(llm);

// ---------------------------------------------------------------- chain
let chain: ChainAdapter = new MockChain();
if (config.chain === 'near') {
  const keys = Object.fromEntries(NPCS.map((id) => [NPC_DEFS[id].account, config.near.npcKeys[id]]));
  chain = new NearChain(config.near.rpcUrl, keys);
}
const signer = new NpcSigner(chain, config.near.contract);

const game = new Game({ seed: config.seed, world, replayDays: world ? undefined : replayDays }, brain, signer, chain);
log(`world=${config.worldSource} brain=${brain.name} chain=${chain.kind} contract=${config.near.contract}`);

// ---------------------------------------------------------------- transport
const clients = new Map<WebSocket, string>();

const http = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  const v = game.village;
  if (req.url === '/api/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, day: v.day, hour: v.hour, players: Object.keys(v.s.players).length, brain: brain.name, chain: chain.kind }));
  } else if (req.url === '/api/state') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(v.snapshot()));
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  ws.on('message', async (buf) => {
    let msg: { id?: number; type: string; playerId?: string; name?: string; action?: Action; npc?: NpcId; message?: string };
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    const reply = (result: unknown) => ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
    if (msg.type === 'hello' && msg.playerId) {
      const id = msg.playerId.slice(0, 64);
      clients.set(ws, id);
      game.join(id, (msg.name ?? id).slice(0, 32));
      ws.send(JSON.stringify({ type: 'state', state: game.village.s }));
      return;
    }
    const playerId = clients.get(ws);
    if (!playerId) return reply({ ok: false, reason: 'say hello first' });
    if (msg.type === 'act' && msg.action) {
      reply(game.act(playerId, msg.action));
      broadcast();
    } else if (msg.type === 'haggle' && msg.npc && NPCS.includes(msg.npc) && typeof msg.message === 'string') {
      try {
        reply(await game.haggle(msg.npc, msg.message));
      } catch (e) {
        reply({ reply: `${NPC_DEFS[msg.npc].name} is thinking too hard (brain error: ${(e as Error).message}).`, brain: brain.name });
      }
      broadcast();
    }
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcast() {
  const payload = JSON.stringify({ type: 'state', state: game.village.s });
  for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(payload);
}

setInterval(() => {
  game.tick();
  broadcast();
}, config.secondsPerGameHour * 1000);

http.listen(config.port, () => log(`Hearthmarket server on http://localhost:${config.port}  (ws same port)`));
