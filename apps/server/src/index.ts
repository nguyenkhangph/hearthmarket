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
import { Negotiator } from './brain/negotiator.ts';
import { OpenAiCompatible, WithFallback } from './brain/llm.ts';
import { MockChain, NpcSigner, type ChainAdapter } from './chain/signer.ts';
import { NearChain, parseRpcUrls, withBalances } from './chain/near.ts';
import { ChainMirror, type WorldPostInput } from './chain/mirror.ts';
import { OpenMeteoWorld, worldPost } from './world/openMeteo.ts';
import { fetchIntentsReading, type IntentsReading } from './world/intents.ts';
import { dashboardView, firstName, type RedTeamStats } from './dashboard.ts';
import { authenticate, claimKey, GoogleVerifier, randomSecret, type HelloAuth, type Session } from './auth.ts';

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
let fx: IntentsReading | undefined;
const withFx = (p: WorldPostInput): WorldPostInput =>
  fx ? { ...p, source: `${p.source} · world money: ${fx.quote} from ${fx.source} (payload sha256 ${fx.sha256}), factor ${fx.factor.toFixed(3)}` } : p;
const currentWorldPost = (): WorldPostInput | undefined => {
  if (om?.latestPost && world.last?.source === 'open-meteo') return withFx(om.latestPost);
  if (!world.last) return undefined;
  const label = config.worldSource === 'replay' ? `replay:${config.worldReplayFile} (scripted demo week, not live data)` : 'synthetic (generated, not live data)';
  return withFx(worldPost(world.last, JSON.stringify(world.last), label));
};

// ---------------------------------------------------------------- brain
const { primary, fallback } = config.llm;
const llmOn = config.brain === 'llm' && !!primary.apiKey && !!primary.model;
if (config.brain === 'llm' && !llmOn) log('NPC_BRAIN=llm but NEAR_AI_API_KEY or NEAR_AI_MODEL is empty: using the rule brain. Run `npm run llm:check`.');
const llm = llmOn ? new WithFallback(new OpenAiCompatible(primary), fallback.baseUrl ? new OpenAiCompatible(fallback) : undefined) : null;
const brain = new NpcBrain(llm);
const planner = llm ? new DayPlanner(brain, { everyMs: config.planEveryMinutes * 60_000, log }) : undefined;
// agent-to-agent deals: the model when configured (every NPC_DEAL_MINUTES per pair), rules otherwise (daily)
// model calls cost credits: only while someone is playing (rules are free and run regardless)
// a dashboard viewer counts as someone watching for a minute after each refresh (judges often
// open the dashboard without playing): the agents think with the model and act on chain for them
let lastViewerAt = 0;
const watchers = () => sessions.size + (Date.now() - lastViewerAt < 60_000 ? 1 : 0);
const someoneOnline = () => watchers() > 0;
const negotiator = new Negotiator(llm, { everyMs: config.dealEveryMinutes * 60_000, log, useModel: someoneOnline });

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
  const near = withBalances(new NearChain(rpcUrls, keys));
  chain = near;
  log(`rpc: ${rpcUrls.join(' , ')}`);
  mirror = new ChainMirror(chain, {
    contract: config.near.contract,
    operator,
    playerAccount: (id) => accounts.get(id) ?? null,
    minDayMs: config.near.daySeconds * 1000,
    maxPerMinute: config.near.maxTxPerMinute,
    npcCallsPerHour: config.near.npcTxPerHour,
    batchProduce: config.near.batchProduce,
    log,
  });
  log(`gas budget: ${config.near.npcTxPerHour || 'unlimited'} calls per NPC per hour, produce ${config.near.batchProduce ? 'batched per day' : 'per tick'}, day sync every ${config.near.daySeconds}s, ${config.near.idleSeconds ? `pause ${config.near.idleSeconds}s after the last player leaves` : 'never pauses'}`);
  const m = mirror;
  // version 4 adds relay_deliver_request; older contracts keep NPC requests off chain
  void near.view<string>(config.near.contract, 'get_version').then((ver) => {
    m.contractVersion = Number(ver) || 0;
    log(`contract ${config.near.contract} version ${ver}${m.contractVersion < 4 ? ' (NPC requests stay off chain until version 4 is deployed)' : ''}`);
  }).catch((e) => log(`get_version failed: ${(e as Error).message}`));
  const checkBalances = () => void m.checkBalances(config.near.lowBalanceNear).catch(() => {});
  setTimeout(checkBalances, 5_000);
  setInterval(checkBalances, 10 * 60_000).unref();
}
const signer = new NpcSigner(chain, config.near.contract);

// ---------------------------------------------------------------- idle pause
// Nobody watching = no gas: NPC actions stay in the engine; the first player back re-anchors the chain.
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function onPresence(players: number) {
  if (!mirror || !config.near.idleSeconds) return;
  if (players > 0) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!mirror.isActive) {
      mirror.setActive(true);
      log('chain: someone is playing or watching the dashboard, NPC actions go on chain again');
      mirror.startDay(game.village, currentWorldPost());
    }
  } else if (mirror.isActive && !idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      mirror?.setActive(false);
      log(`chain: nobody online for ${config.near.idleSeconds}s, NPC actions stay off chain until someone joins`);
    }, config.near.idleSeconds * 1000);
  }
}

const game = new Game(
  { seed: config.seed, world, mirror, worldPost: currentWorldPost, onNewDay: (v) => {
    if (someoneOnline()) planner?.onNewDay(v);
    void negotiator.onNewDay(v);
  } },
  brain, signer, chain,
);
// world money from NEAR Intents (read-only quote of tokenized gold)
if (config.worldFx === 'near-intents') {
  const readFx = async () => {
    try {
      fx = await fetchIntentsReading();
      const applied = game.village.setWorldFx(fx);
      log(`near intents: ${fx.quote}, world prices x${applied.factor.toFixed(3)}`);
    } catch (e) {
      log(`near intents unavailable, keeping the last rate: ${(e as Error).message}`);
    }
  };
  await readFx();
  setInterval(() => void readFx(), config.worldFxMinutes * 60_000).unref();
}

// sync the chain to the engine right away, not only at the next game day
mirror?.startDay(game.village, currentWorldPost());
onPresence(0);
// dashboard viewers leave without a goodbye: re-check presence every 30 s
setInterval(() => onPresence(watchers()), 30_000).unref();
log(`world=${config.worldSource} brain=${brain.name} chain=${chain.kind} contract=${config.near.contract} login=${google ? 'google' : ''}${config.auth.devLogin ? (google ? '+dev' : 'dev') : ''}`);

// ---------------------------------------------------------------- transport
const sessions = new Map<WebSocket, Session>();
const lastAttack = new WeakMap<WebSocket, number>();
/** times of on-chain red-team proofs in the last hour (each one costs a little gas) */
const proofs: number[] = [];
const redTeam: RedTeamStats = { runs: 0, blocked: 0, bySigner: 0, byContract: 0, onChain: 0 };
const startedAt = Date.now();

const http = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  const v = game.village;
  if (req.url === '/api/health') {
    res.end(JSON.stringify({
      ok: true, day: v.day, hour: v.hour, players: Object.keys(v.s.players).length, brain: brain.name, chain: chain.kind,
      chainStats: mirror ? { ...mirror.stats, active: mirror.isActive, balances: mirror.balances } : undefined, rpcStats: chain instanceof NearChain ? chain.stats : undefined, plans: planner ? { calls: planner.calls, failures: planner.failures } : undefined,
      deals: { by: negotiator.name, calls: negotiator.calls, failures: negotiator.failures },
    }));
  } else if (req.url === '/api/config') {
    res.end(JSON.stringify({ googleClientId: config.auth.googleClientId, devLogin: config.auth.devLogin, contract: config.near.contract, chain: chain.kind }));
  } else if (req.url === '/api/dashboard') {
    lastViewerAt = Date.now();
    onPresence(watchers());
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(dashboardView(v, { online: sessions.size, brain: brain.name, chain: chain.kind, contract: config.near.contract, mirror, redTeam, startedAt, playerAccount: (id) => accounts.get(id) ?? null })));
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
    let msg: { id?: number; type: string; idToken?: string; auth?: HelloAuth; playerId?: string; name?: string; action?: Action; npc?: NpcId; message?: string; attack?: number };
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
        onPresence(watchers());
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
        reply(await game.haggle(msg.npc, msg.message, undefined, session.playerId));
      } catch (e) {
        reply({ reply: `${NPC_DEFS[msg.npc].name} is thinking too hard (brain error: ${(e as Error).message}).`, brain: brain.name });
      }
      broadcast();
    } else if (msg.type === 'claim') {
      try {
        const k = await claimKey(session, msg.idToken, authCfg, google);
        log(`claim: ${session.name} exported the key of ${k.accountId.slice(0, 8)}…`);
        reply({ ok: true, ...k, contract: config.near.contract });
      } catch (e) {
        reply({ ok: false, reason: (e as Error).message });
      }
    } else if (msg.type === 'redteam' && Number.isInteger(msg.attack)) {
      const now = Date.now();
      if (now - (lastAttack.get(ws) ?? 0) < 4000) return reply({ error: 'one attack every 4 seconds' });
      lastAttack.set(ws, now);
      proofs.splice(0, proofs.length, ...proofs.filter((t) => now - t < 3_600_000));
      const proveOnChain = chain.kind === 'near' && proofs.length < config.near.redTeamProofsPerHour;
      try {
        const out = await game.redTeam(msg.attack!, session.account, { proveOnChain, playerId: session.playerId });
        if (out.proof) proofs.push(now);
        redTeam.runs++;
        if (out.blocked) redTeam.blocked++;
        if (out.layer === 'signer') redTeam.bySigner++;
        if (out.layer === 'contract') redTeam.byContract++;
        if (out.proof?.hash) redTeam.onChain++;
        redTeam.last = { attack: out.attack, npc: out.npc, layer: out.layer, hash: out.proof?.hash, at: now };
        const who = (redTeam.players ??= {})[session.playerId] ??= { name: firstName(session.name), runs: 0, blocked: 0, onChain: 0 };
        who.runs++;
        if (out.blocked) who.blocked++;
        if (out.proof?.hash) who.onChain++;
        reply(out);
      } catch (e) {
        reply({ error: (e as Error).message });
      }
      broadcast();
    }
  });
  ws.on('close', () => {
    sessions.delete(ws);
    onPresence(watchers());
  });
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
