import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  NPCS, NPC_DEFS, ReplayWorld, SyntheticWorld, setContractAccount,
  type Action, type NpcId, type WorldDay, type WorldSource,
} from '@hearth/economy';
import { config } from './config.ts';
import { Game } from './game.ts';
import { NpcBrain } from './brain/brain.ts';
import { DayPlanner } from './brain/planner.ts';
import { OpenAiCompatible, WithFallback } from './brain/llm.ts';
import { MockChain, NpcSigner, type ChainAdapter } from './chain/signer.ts';
import { NearChain, parseRpcUrls } from './chain/near.ts';
import { ChainMirror, type WorldPostInput } from './chain/mirror.ts';
import { OpenMeteoWorld, worldPost } from './world/openMeteo.ts';
import { authenticate, GoogleVerifier, randomSecret, type HelloAuth, type Session } from './auth.ts';

setContractAccount(config.near.contract);
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- world
/** Remembers the last day handed to the engine, for the oracle's on-chain post. */
class Tap implements WorldSource {
  last?: WorldDay;
  constructor(private inner: WorldSource) {}
  next() {
    this.last = this.inner.next();
    return this.last;
  }
}
const replayDays = (JSON.parse(readFileSync(join(root, config.worldReplayFile), 'utf8')) as { days: WorldDay[] }).days;
let om: OpenMeteoWorld | undefined;
let inner: WorldSource;
if (config.worldSource === 'open-meteo') {
  om = new OpenMeteoWorld(replayDays[0], (e) => log('open-meteo error, keeping the last reading:', e.message));
  const dir = join(root, 'data/world/posted');
  om.onPayload = (sha, payload) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sha}.json`), payload);
    } catch {
      /* best effort: the hash is on chain either way */
    }
  };
  await om.start(config.worldRefreshHours * 3600_000);
  log(`open-meteo: ${om.latestPost ? `live reading ${om.next().fetchedAt}` : 'API unreachable, using the replay day until it answers'}`);
  inner = om;
} else if (config.worldSource === 'synthetic') {
  inner = new SyntheticWorld(config.seed);
} else {
  inner = new ReplayWorld(replayDays);
}
const world = new Tap(inner);
const currentWorldPost = (): WorldPostInput | undefined => {
  if (om?.latestPost && world.last?.source === 'open-meteo') return om.latestPost;
  if (!world.last) return undefined;
  const label = config.worldSource === 'replay' ? `replay:${config.worldReplayFile} (scripted demo week, not live data)` : 'synthetic (generated, not live data)';
  return worldPost(world.last, JSON.stringify(world.last), label);
};

// ---------------------------------------------------------------- brain
const { primary, fallback } = config.llm;
const llmOn = config.brain === 'llm' && !!primary.apiKey && !!primary.model;
if (config.brain === 'llm' && !llmOn) log('NPC_BRAIN=llm but NEAR_AI_API_KEY or NEAR_AI_MODEL is empty: using the rule brain. Run `npm run llm:check`.');
const llm = llmOn ? new WithFallback(new OpenAiCompatible(primary), fallback.baseUrl ? new OpenAiCompatible(fallback) : undefined) : null;
const brain = new NpcBrain(llm);
const planner = llm ? new DayPlanner(brain, { everyMs: config.planEveryMinutes * 60_000, log }) : undefined;

// ---------------------------------------------------------------- players
let secret = config.auth.playerKeySecret;
if (!secret) {
  secret = randomSecret();
  log('PLAYER_KEY_SECRET is empty: player accounts change on every restart. Set it in .env (any long random string).');
}
const authCfg = { ...config.auth, playerKeySecret: secret };
const google = config.auth.googleClientId ? new GoogleVerifier(config.auth.googleClientId) : undefined;
const accounts = new Map<string, string>(); // engine player id -> NEAR account

// ---------------------------------------------------------------- chain
let chain: ChainAdapter = new MockChain();
let mirror: ChainMirror | undefined;
if (config.chain === 'near') {
  const keys: Record<string, string> = Object.fromEntries(NPCS.map((id) => [NPC_DEFS[id].account, config.near.npcKeys[id]]));
  const missing = NPCS.filter((id) => !config.near.npcKeys[id]);
  if (missing.length) log(`no key for ${missing.join(', ')}: their actions stay off chain. Run \`npm run setup:testnet\`.`);
  const operator = config.near.oracleKey ? config.near.oracleAccount || config.near.contract : '';
  if (operator) keys[operator] = config.near.oracleKey;
  else log('no ORACLE_KEY: no day sync, world posts or player relays. Run `npm run setup:testnet`.');
  const rpcUrls = parseRpcUrls(config.near.rpcUrl);
  chain = new NearChain(rpcUrls, keys);
  log(`rpc: ${rpcUrls.join(' , ')}`);
  mirror = new ChainMirror(chain, {
    contract: config.near.contract,
    operator,
    playerAccount: (id) => accounts.get(id) ?? null,
    minDayMs: config.near.daySeconds * 1000,
    maxPerMinute: config.near.maxTxPerMinute,
    log,
  });
}
const signer = new NpcSigner(chain, config.near.contract);

const game = new Game(
  { seed: config.seed, world, mirror, worldPost: currentWorldPost, onNewDay: (v) => planner?.onNewDay(v) },
  brain, signer, chain,
);
// sync the chain to the engine right away, not only at the next game day
mirror?.startDay(game.village, currentWorldPost());
log(`world=${config.worldSource} brain=${brain.name} chain=${chain.kind} contract=${config.near.contract} login=${google ? 'google' : ''}${config.auth.devLogin ? (google ? '+dev' : 'dev') : ''}`);

// ---------------------------------------------------------------- transport
const sessions = new Map<WebSocket, Session>();

const http = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  const v = game.village;
  if (req.url === '/api/health') {
    res.end(JSON.stringify({
      ok: true, day: v.day, hour: v.hour, players: Object.keys(v.s.players).length, brain: brain.name, chain: chain.kind,
      chainStats: mirror?.stats, rpcStats: chain instanceof NearChain ? chain.stats : undefined, plans: planner ? { calls: planner.calls, failures: planner.failures } : undefined,
    }));
  } else if (req.url === '/api/config') {
    res.end(JSON.stringify({ googleClientId: config.auth.googleClientId, devLogin: config.auth.devLogin, contract: config.near.contract, chain: chain.kind }));
  } else if (req.url === '/api/state') {
    res.end(JSON.stringify(v.snapshot()));
  } else {
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  }
});

const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  ws.on('message', async (buf) => {
    let msg: { id?: number; type: string; auth?: HelloAuth; playerId?: string; name?: string; action?: Action; npc?: NpcId; message?: string };
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    const reply = (result: unknown) => ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
    if (msg.type === 'hello') {
      try {
        const s = await authenticate(msg.auth, { playerId: msg.playerId, name: msg.name }, authCfg, google);
        sessions.set(ws, s);
        accounts.set(s.playerId, s.account);
        game.join(s.playerId, s.name);
        ws.send(JSON.stringify({ type: 'welcome', playerId: s.playerId, name: s.name, account: s.account, auth: s.auth, contract: config.near.contract, chain: chain.kind }));
        ws.send(JSON.stringify({ type: 'state', state: game.village.s }));
        log(`${s.auth} login: ${s.name} -> ${s.account.slice(0, 8)}…`);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'denied', reason: (e as Error).message }));
      }
      return;
    }
    const session = sessions.get(ws);
    if (!session) return reply({ ok: false, reason: 'sign in first' });
    if (msg.type === 'act' && msg.action) {
      reply(game.act(session.playerId, msg.action));
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
  ws.on('close', () => sessions.delete(ws));
});

function broadcast() {
  const payload = JSON.stringify({ type: 'state', state: game.village.s });
  for (const ws of sessions.keys()) if (ws.readyState === ws.OPEN) ws.send(payload);
}

setInterval(() => {
  game.tick();
  broadcast();
}, config.secondsPerGameHour * 1000);

http.listen(config.port, () => log(`Hearthmarket server on http://localhost:${config.port}  (ws same port)`));
