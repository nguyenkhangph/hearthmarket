import {
  fmt, g, playerSigner, NEAR_CONFIG, RED_TEAM_ATTACKS, ITEMS, ITEM_DEFS, NPC_DEFS, NPCS, NPC_KEY_METHODS, QUESTS, RULES, marketView, midPrice, fee, short, txKind, txState, TX_STATE_HINT,
  type Action, type ItemId, type KeeperStrategy, type NpcId, type Village, type FeedEvent, type MarketRow,
} from '@hearth/economy';
import { icon } from './assets.ts';
import { chime, coinBurst, floatText, isMuted, lastPointer, setMuted } from './juice.ts';
import { goalView, tally as councilTally, MOTIONS, haggleRound, HAGGLE_ROUNDS, economyHealth, negotiateContractRules, regardBps, replayChallenge, CHALLENGES, type Challenge, type ChallengeResult, type WorldDay } from '@hearth/economy';
import replayWeek from '../../../data/world/replay-kansas-heatwave.json';
import type { GameSource } from './source.ts';

type PanelId = 'market' | 'guild' | 'economy' | 'npc' | 'account' | 'proof' | null;

/** What the page around the UI can do (main.ts): bring the sign-in back for a guest. */
export interface UiHooks {
  /** shows the sign-in screen again; undefined when this build has no online village */
  signIn?: () => void;
}

/** A few real testnet transactions from the hosted village, shown to guests under "Prove on NEAR". */
interface ProofEvent { at: number; signer: string; method: string; ok: boolean; hash: string; reason?: string; redTeam?: boolean; attack?: string }

const PROOF_LABEL: Record<string, string> = {
  relay_register_player: 'A new player registered',
  relay_market_buy: "A player's market buy, relayed by the game",
  relay_deliver_request: 'A request delivered to an NPC',
  mint_badge: 'A soulbound badge minted (NEP-171)',
  hire: 'An NPC hiring another NPC',
  relay_stall_list: "A player's goods listed into the stalls contract's escrow",
  relay_stall_buy: 'A player bought a stall-board listing',
  relay_stall_cancel: 'A stall-board listing cancelled, goods back',
  npc_stall_buy: "An NPC bought a player's listing, with its own key",
};

const LS = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/** Feed lines carry short tx hashes for the record; in play they stay out of sight (see "Prove on NEAR"). */
export const stripTx = (text: string) => text.replace(/ · refused on chain, tx \S+/g, ' · refused on chain').replace(/ · tx \S+/g, '');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const hh = (t: number) => `${String(t % 24).padStart(2, '0')}:00`;
const pct = (x: number, digits = 0) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;

const NPC_NAMES = NPCS.map((id) => NPC_DEFS[id].name);
const EXPLORER = 'https://testnet.nearblocks.io';

export class Ui {
  private panel: PanelId = null;
  private npc: NpcId = 'theo';
  private orderForm = { item: 'sword' as ItemId, qty: 2, maxPrice: 0, deadline: 2, fromGuild: false };
  /** stall board form: price 0 = fill in the village price */
  private listForm = { item: 'wheat' as ItemId, qty: 1, price: 0 };
  private keeperForm = { npc: 'buba' as NpcId, strategy: 'hold' as KeeperStrategy };
  private haggleLog: { who: 'me' | 'npc' | 'sys' | 'bad' | 'ok'; text: string; html?: string }[] = [];
  private redBusy = false;
  /** selected red-team attack (index into RED_TEAM_ATTACKS), kept across re-renders */
  private redAttack = -1;
  private claimed: { accountId: string; privateKey: string; contract: string } | null = null;
  private claimError = '';
  private lastDay = 0;
  private simSummary: string | null = null;
  private proofHistory: ProofEvent[] = [];
  private ch?: Challenge;
  private chBusy = false;
  private chResult?: { r: ChallengeResult; replayed: boolean };
  private acctHtml = '';
  /** the first trade's receipt card: open until the player closes it */
  private receipt = false;
  private tour = {
    open: false,
    started: 0,
    startDay: 0,
    saw: { npc: false, prove: false, hover: false, haggle: 0 },
    redTeamed: false,
    /** steps stay ticked once done (a filled order leaves the order book) */
    done: new Set<string>(),
  };

  constructor(
    private src: GameSource,
    private portrait: (id: NpcId, canvas: HTMLCanvasElement) => void,
    private face: (id: NpcId) => string | undefined = () => undefined,
    private hooks: UiHooks = {},
  ) {
    document.querySelectorAll<HTMLElement>('[data-panel]').forEach((b) =>
      b.addEventListener('click', () => this.open(b.dataset.panel as PanelId)),
    );
    $('#place-order').addEventListener('click', () => this.open('market'));
    $('#account').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-open="account"]')) this.open('account');
      if ((e.target as HTMLElement).closest('[data-signin]')) this.hooks.signIn?.();
    });
    $('#prove').addEventListener('click', () => this.open('proof'));
    $('#tour-btn').addEventListener('click', () => this.toggleTour());
    const mute = $('#mute');
    const showMute = () => { mute.textContent = isMuted() ? '🔇' : '🔊'; mute.title = isMuted() ? 'Sound off' : 'Sound on'; };
    showMute();
    mute.addEventListener('click', () => { setMuted(!isMuted()); showMute(); if (!isMuted()) chime('gain'); });
    // these cards re-render with the clock: act on pointerdown so a click is never lost mid-render
    for (const id of ['#receipt', '#tour']) {
      $(id).addEventListener('pointerdown', (e) => this.cardDown(e as PointerEvent));
    }
    $('#panel').addEventListener('click', (e) => this.onPanelClick(e));
    $('#quests').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-qtoggle]')) {
        this.questsOpen = !this.questsOpen;
        try { localStorage.setItem('hm.quests', this.questsOpen ? 'open' : 'closed'); } catch { /* private mode */ }
        this.renderQuests();
        return;
      }
      if ((e.target as HTMLElement).closest('[data-kopen]')) {
        this.open('market');
        $('.keeper', $('#panel'))?.scrollIntoView({ block: 'center' });
        return;
      }
      const cv = (e.target as HTMLElement).closest<HTMLElement>('[data-cvote]');
      if (cv) {
        const m = this.v.s.council?.at(-1);
        if (m) void this.act({ type: 'council_vote', id: m.id, yes: cv.dataset.cvote === 'yes' });
        return;
      }
      const co = (e.target as HTMLElement).closest<HTMLElement>('[data-coop]');
      if (co) { void this.act({ type: 'coop_give', id: Number(co.dataset.coop), qty: Number(co.dataset.qty) }); return; }
      if ((e.target as HTMLElement).closest('[data-goal]')) {
        void this.act({ type: 'start_goal' });
        return;
      }
      const acc = (e.target as HTMLElement).closest<HTMLElement>('[data-accept]');
      if (acc) { void this.act({ type: 'accept_request', requestId: Number(acc.dataset.accept) }); return; }
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-req]');
      if (b) void this.act({ type: 'deliver_request', requestId: Number(b.dataset.req) });
    });
    $('#panel').addEventListener('input', (e) => this.onPanelInput(e));
    $('#panel').addEventListener('submit', (e) => e.preventDefault());
    src.onUpdate(() => this.render());
    src.onFeed((e) => this.onFeed(e));
    fetch('sim-summary.json').then((r) => (r.ok ? r.json() : null)).then((j) => { this.simSummary = j?.text ?? null; }).catch(() => {});
    import('../../../data/proof-history.json').then((m) => { this.proofHistory = (m.default as { events: ProofEvent[] }).events; }).catch(() => {});
    const q = new URLSearchParams(location.search);
    this.ch = (src as { challenge?: Challenge }).challenge;
    if (this.ch) {
      (src as { onChallengeEnd?: () => void }).onChallengeEnd = () => this.challengeEnd();
      // the card re-renders every game hour: act on pointerdown so a click is never lost mid-render
      $('#challenge').addEventListener('pointerdown', (e) => this.cardDown(e as PointerEvent));
    } else if (q.has('tour') || !LS.get('hm.tour')) this.toggleTour(true);
    this.render();
  }

  get v(): Village {
    return this.src.village();
  }

  get me() {
    return this.v.s.players[this.src.playerId];
  }

  open(p: PanelId, npc?: NpcId) {
    if (npc) this.npc = npc;
    this.panel = this.panel === p && !npc ? null : p;
    if (this.panel === 'npc') this.tour.saw.npc = true;
    if (this.panel === 'proof') {
      this.tour.saw.prove = true;
      this.receipt = false;
    }
    document.querySelectorAll<HTMLElement>('[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === this.panel));
    this.renderPanel(true);
  }

  toast(text: string, bad = false) {
    const t = $('#toast');
    t.textContent = text;
    t.className = `toast show ${bad ? 'bad' : ''}`;
    clearTimeout((t as HTMLElement & { _h?: number })._h);
    (t as HTMLElement & { _h?: number })._h = window.setTimeout(() => (t.className = 'toast'), 3200);
  }

  private lastClickAt = -Infinity;

  private async act(a: Action, okText?: string) {
    this.lastClickAt = performance.now();
    const r = await this.src.act(a);
    if (r.ok) this.toast(okText ?? r.info ?? 'Done');
    else {
      this.toast(r.reason, true);
      chime('bad');
    }
    if (r.ok && ['market_buy', 'place_order', 'deliver_request'].includes(a.type)) this.firstTrade();
    this.render();
    return r;
  }

  // ------------------------------------------------------------------ render
  render() {
    this.renderTop();
    this.renderWorld();
    this.renderFeed();
    this.renderQuests();
    this.renderReceipt();
    this.renderTour();
    this.renderChallenge();
    this.renderPanel(false);
  }

  // ------------------------------------------------------------------ 3-day harvest challenge
  /** The round's card: the bulletin, the contract, where you stand against the goal. */
  private renderChallenge() {
    const c = this.ch;
    const el = $('#challenge');
    if (!c) return;
    el.classList.remove('hidden');
    if (this.chResult) return; // the end card stays as it is
    const sp = c.spec;
    const k = sp.contract;
    const p = c.player;
    const worth = c.worth();
    const d = worth - c.startWorth;
    const hoursLeft = Math.max(0, c.endTick - c.v.s.tick);
    // keep what the player is typing across the hourly re-render
    const typed = el.querySelector<HTMLInputElement>('[name="pitch"]');
    const keep = typed ? { v: typed.value, focus: document.activeElement === typed, pos: typed.selectionStart ?? typed.value.length } : null;
    el.innerHTML = `
      <h4>🏆 Harvest challenge <span class="muted">${esc(sp.level)} · seed ${sp.seed}</span></h4>
      <div class="small">Day ${Math.min(c.day, sp.days)} of ${sp.days} · ${hh(c.v.s.tick)} · <b>${hoursLeft} h left</b> (ends 18:00 day ${sp.days})</div>
      <ul class="bulletin">${c.bulletin().slice(0, 2).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="kvrow small"><span>Contract: ${k.qty} ${esc(k.item)} → ${esc(NPC_DEFS[k.npc].name)} at ${fmt(c.contractPrice, 2)}</span>
        <span>${c.delivered ? '<b class="up">kept ✓</b>' : `you hold ${p.stock[k.item]}/${k.qty} <button class="mini primary" data-card="ch-deliver" ${p.stock[k.item] < k.qty ? 'disabled' : ''}>Deliver</button>`}</span></div>
      ${!c.delivered && c.contractBy === 'default' ? `<div class="row"><input name="pitch" class="grow" placeholder="Pitch Chloe, e.g. 'I deliver early, ${fmt(Math.round(c.contractMid * 1.3), 2)}?'" maxlength="200"><button class="mini" data-card="ch-negotiate" ${this.chBusy ? 'disabled' : ''} title="Chloe answers with the game server's model (NEAR AI Cloud) when it is reachable, else with rules. Price stays within ${fmt(c.contractRange()[0], 2)}-${fmt(c.contractRange()[1], 2)}.">🤝 Negotiate</button></div>` : ''}
      ${c.contractBy !== 'default' ? `<div class="small"><span class="src ${/^rules/.test(c.contractBy) ? 'rules' : 'llm'}">${esc(/^rules/.test(c.contractBy) ? c.contractBy : `LLM · ${c.contractBy}`)}</span> Chloe: "${esc(c.contractSay)}"</div>` : ''}
      <div class="kvrow small"><span>${esc(k.item)} now</span><span class="mono">${fmt(midPrice(k.item, c.v.s.market.stock[k.item]), 2)}</span></div>
      <div class="kvrow small"><span>Net worth (goods at what the market pays)</span><span class="mono ${d >= 0 ? 'up' : 'down'}">${fmt(worth)} (${d >= 0 ? '+' : ''}${fmt(d)})</span></div>
      <div class="kvrow small"><span>Goal</span><span class="mono">contract kept and +${fmt(sp.target, 0)}</span></div>
      <div class="row"><button class="mini" data-card="go-market">Market</button><button class="mini" data-card="go-ffwd" title="Run the rest of the round quickly">⏩ to the end</button></div>
      <div class="muted small">Scenario: scripted blight on a replayed weather week. Your moves are recorded; the end card replays them to check the score.</div>`;
    const input = el.querySelector<HTMLInputElement>('[name="pitch"]');
    if (input && keep) {
      input.value = keep.v;
      if (keep.focus) {
        input.focus();
        input.setSelectionRange(keep.pos, keep.pos);
      }
    }
  }

  /** Chloe's answer: the server's model if it answers, else the rules in the browser. */
  private async negotiateContract(c: Challenge, pitch: string) {
    const base = (this.src as { apiBase?: string }).apiBase;
    let r: { price: number; say: string; by: string } | null = null;
    if (base) {
      try {
        const res = await fetch(`${base}/api/challenge/contract`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ mid: c.contractMid, pitch }) });
        if (res.ok) r = await res.json();
      } catch {
        /* offline: rules below */
      }
    }
    r ??= { ...negotiateContractRules(c.contractMid, pitch), by: 'rules (offline)' };
    const out = c.setContractPrice(r.price, r.by, r.say);
    this.toast(out.ok ? `Chloe: ${r.say}` : out.reason, !out.ok);
  }

  private challengeEnd() {
    const c = this.ch!;
    if (this.chResult) return;
    const r = c.result();
    // replay the round from its seed and the recorded moves: it must give the same score
    const again = replayChallenge(c.spec.level, (replayWeek as { days: WorldDay[] }).days, c.moves);
    this.chResult = { r, replayed: JSON.stringify(again) === JSON.stringify(r) };
    const el = $('#challenge');
    el.classList.add('end');
    const lv = c.spec.level;
    const next = lv === 'easy' ? 'normal' : 'hard';
    el.innerHTML = `
      <h4>${r.verdict === 'win' ? '🏆 You win' : '✗ Round lost'} <span class="muted">${esc(lv)} · seed ${r.seed}</span></h4>
      <div class="score">Score <b>${r.score.toFixed(1)}</b> <span class="muted small">= profit ${fmt(r.profit)} gold${r.delivered ? ' + 10 for the contract' : ''}</span></div>
      <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h4>Key decisions</h4>
      <ul>${r.decisions.length ? r.decisions.map((x) => `<li>${esc(x)}</li>`).join('') : '<li>No trades: the blight came and went without you.</li>'}</ul>
      <div class="small">${this.chResult.replayed ? `✓ Replay check: seed ${r.seed} + your ${r.moves} recorded moves give the same score.` : '<span class="down">Replay check failed: please report it.</span>'}</div>
      <div class="row">
        <a class="btn primary" href="?challenge=${lv}">Play again (same seed)</a>
        ${lv !== 'hard' ? `<a class="btn" href="?challenge=${next}">Try ${next}</a>` : ''}
        <a class="btn" href="?guest">Free play</a>
      </div>
      <div class="muted small">${(Object.keys(CHALLENGES) as (keyof typeof CHALLENGES)[]).map((k) => `${k}: goal +${fmt(CHALLENGES[k].target, 0)}`).join(' · ')}</div>`;
  }

  /** gold at the last render, per player: a change plays the trade feedback */
  private lastGold: { id?: string; gold: number } = { gold: 0 };

  private renderTop() {
    const v = this.v;
    const me = this.me;
    $('#gold').innerHTML = `${icon('gold', 16)} ${fmt(me?.gold ?? 0)}`;
    if (me) {
      const delta = this.lastGold.id === me.id ? me.gold - this.lastGold.gold : 0;
      this.lastGold = { id: me.id, gold: me.gold };
      const ff = (this.src as { fastForwarding?: boolean }).fastForwarding;
      if (Math.abs(delta) >= 10 && !ff) {
        const purse = $('#gold');
        floatText(purse, `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta), Math.abs(delta) < 1000 ? 1 : 0)} gold`, delta > 0);
        if (delta > 0) {
          // coins fly from where the player clicked (a trade) or from the middle of the map (an NPC paid)
          const clicked = lastPointer.x !== null && performance.now() - this.lastClickAt < 1500;
          const map = $('#stage')?.getBoundingClientRect();
          coinBurst(clicked ? (lastPointer as { x: number; y: number }) : map ? { x: map.left + map.width / 2, y: map.top + map.height / 2 } : null, purse, Math.min(10, 3 + Math.round(delta / 300)));
        }
        chime(delta > 0 ? 'gain' : 'spend');
      }
    }
    $('#season').textContent = `Day ${v.seasonDay} · ${hh(v.s.tick)}`;
    $('#season').title = `Season ${v.s.season}, day ${v.seasonDay} of ${RULES.seasonDays}`;
    const gl = me?.guild ? v.s.guilds[me.guild] : null;
    const rank = gl ? v.ranking().findIndex((r) => r.guild === gl.id) + 1 : 0;
    $('#guild-chip').textContent = gl ? `${gl.name} #${rank}` : '';
    $('#guild-chip').classList.toggle('hidden', !gl);
    const acct = this.src.account;
    // only touch the DOM when the text changes, or a click landing during a re-render is lost
    const acctHtml = this.src.mode === 'guest'
      ? `${esc(me?.name ?? 'guest')} · guest${this.hooks.signIn ? ' · <button class="linkish" data-signin title="Sign in with Google: your trades go on NEAR testnet, under an account made for you">Sign in</button>' : ''}`
      : `${esc(me?.name ?? '')}${acct ? ` · <button class="linkish" data-open="account" title="Your NEAR account: see it, claim it">${esc(acct.slice(0, 6))}…${esc(acct.slice(-4))}</button>` : ''}`;
    if (this.acctHtml !== acctHtml) $('#account').innerHTML = this.acctHtml = acctHtml;
  }

  private renderWorld() {
    const w = this.v.s.world;
    const rows = ITEMS.filter((i) => ITEM_DEFS[i].world).map((i) => {
      const delta = (w.price[i]! - ITEM_DEFS[i].base) / ITEM_DEFS[i].base;
      const region = w.regions.filter((r) => r.item === i).sort((a, b) => b.severity - a.severity)[0];
      const why = region ? (region.severity > 0.25 ? `${region.name} ${region.headline}` : `${region.name} clear`) : 'follows ore + timber';
      return `<div class="wrow">${icon(i)} <b>${ITEM_DEFS[i].name}</b> <span class="${delta > 0.004 ? 'up' : delta < -0.004 ? 'down' : ''}">${pct(delta)}</span> <span class="muted">· ${esc(why)}</span></div>`;
    });
    const ship = w.shippingBps / RULES.shippingBps - 1;
    const mal = w.regions.find((r) => r.id === 'malacca');
    rows.push(`<div class="wrow ship">Shipping ${pct(ship)} <span class="muted">· Malacca ${mal && mal.severity > 0.25 ? 'storm' : 'calm'}</span></div>`);
    const fc = w.regions.filter((r) => r.forecast).map((r) => `<div class="forecast">Forecast: ${esc(r.forecast)} (${esc(r.name)})</div>`).join('');
    const xaut = w.fx ? /XAUT ([\d.]+)/.exec(w.fx.quote)?.[1] : undefined;
    const fx = w.fx ? `<div class="wrow ship" title="${esc(w.fx.quote)} · ${esc(w.fx.source)} · ${esc(w.fx.at)}">World money ×${w.fx.factor.toFixed(3)} <span class="muted">· gold ${xaut ? `$${Math.round(Number(xaut))}` : ''} via NEAR Intents</span></div>` : '';
    $('#world').innerHTML = `<h3>World market today</h3>${rows.join('')}${fx}${fc}<div class="src muted">Weather: ${esc(w.source)} · Open-Meteo (CC BY 4.0)${w.fx ? ' · gold rate: NEAR Intents' : ''}</div>`;
  }

  private highlight(text: string) {
    let t = esc(text);
    const names = [...NPC_NAMES, ...Object.values(this.v.s.guilds).map((x) => x.name)];
    for (const n of names) t = t.replaceAll(esc(n), `<b class="hl">${esc(n)}</b>`);
    t = t.replace(/(Kansas|Malacca|Can Tho|Kamloops|Port Hedland|Pilbara)/g, '<b class="place">$1</b>');
    t = t.replace(/BLOCKED/g, '<b class="blocked">BLOCKED</b>');
    return t;
  }

  private renderFeed() {
    const feed = this.v.s.feed.slice(-40).reverse();
    $('#feed-list').innerHTML = feed
      .map((e) => {
        const html = this.highlight(stripTx(e.text));
        const f = e.npc ? this.face(e.npc) : undefined;
        return `<li class="k-${e.kind}"><time>${hh(e.t)}</time><span>${f ? `<img class="face" src="${f}" alt="">` : ''}${html}</span></li>`;
      })
      .join('');
  }

  private questsOpen = (() => { try { return localStorage.getItem('hm.quests') !== 'closed'; } catch { return true; } })();

  /** Bottom-left card, kept small so it does not cover the village: next starter step, today's requests, badges. */
  /** The village council (vote today) and Bruno's co-op caravan (chip in), when there is one. */
  private socialHtml(): string {
    const me = this.me;
    const v = this.v;
    if (!me || this.ch || !v.s.council) return '';
    let html = '';
    const m = v.s.council.at(-1);
    if (m && (m.status === 'open' || (m.status === 'passed' && v.day <= m.to!))) {
      const t = councilTally(m);
      const mine = m.votes.find((x) => x.kind === 'player' && x.who === me.id);
      const mark = (x: (typeof m.votes)[number]) => (x.vote === 'yes' ? '✓' : x.vote === 'no' ? '✗' : '–');
      const faces = m.votes.filter((x) => x.kind === 'npc' || x.who === 'ai-rival').map((x) => {
        const f = x.kind === 'npc' ? this.face(x.who as NpcId) : '';
        return `<span class="cv ${x.vote}" title="${esc(`${x.name}: ${x.vote}${x.why ? `, ${x.why}` : ''}`)}">${f ? `<img class="face" src="${f}" alt="">` : '🤖'}${mark(x)}</span>`;
      }).join('');
      const players = m.votes.filter((x) => x.kind === 'player' && x.who !== 'ai-rival').length;
      html += m.status === 'open'
        ? `<div class="soc council"><div class="soc-head"><span>🏛 Council · counted at 20:00</span><span class="${t.passes ? 'up' : 'down'}">${t.yes} yes · ${t.no} no</span></div>
          <div class="small">${esc(m.title)}</div>
          <div class="cvotes">${faces}${players ? `<span class="muted small">+${players} player${players === 1 ? '' : 's'}</span>` : ''}</div>
          <div class="soc-foot small"><span class="muted">${mine ? `you voted ${mine.vote}` : 'hover a face for its reason · ties fail'}</span><span><button class="mini" data-cvote="yes">Yes</button> <button class="mini" data-cvote="no">No</button></span></div></div>`
        : `<div class="soc council small" title="${esc(m.votes.map((x) => `${x.name}: ${x.vote}${x.why ? ` (${x.why})` : ''}`).join('\n'))}">🏛 <b>In force</b> to day ${m.to! - v.day + v.seasonDay} · ${esc(MOTIONS[m.kind].effect)}</div>`;
    }
    const c = (v.s.coops ?? []).filter((x) => x.status === 'open' || (x.status === 'filled' && v.day - x.day <= 3)).at(-1);
    if (c) {
      const filled = c.parts.reduce((t, p) => t + p.qty, 0);
      const have = me.stock[c.item];
      const give = Math.min(have, c.qty - filled);
      const parts = c.parts.map((p) => `${esc(p.id === me.id ? 'you' : p.name)} ${p.qty}${p.bonus ? ` (+${fmt(p.bonus)})` : ''}`).join(' · ');
      const left = c.due - v.day;
      html += `<div class="soc coop" title="Bruno pays ${fmt(c.price, 2)} per ${esc(c.item)} on delivery (25% over the market when posted); when the lot is full, ${fmt(c.bonus, 0)} gold is split by share among everyone who chipped in. NPC producers and Silas join at 13:00.">
        <div class="soc-head"><span>🤝 Co-op: Bruno's caravan</span><span>${filled}/${c.qty} ${icon(c.item, 12)}</span></div>
        <div class="goal-bar"><b style="width:${Math.min(100, (filled / c.qty) * 100).toFixed(1)}%"></b></div>
        <div class="small muted">${parts || 'nobody yet'}</div>
        <div class="soc-foot small"><span>${c.status === 'filled' ? 'full · bonus paid' : `${fmt(c.price, 2)} each + ${fmt(c.bonus, 0)} bonus · ${left > 0 ? `${left + 1} days left` : 'leaves tonight'}`}</span>${c.status === 'open' ? `<button class="mini" data-coop="${c.id}" data-qty="${give}" ${give > 0 ? '' : 'disabled'} title="${give > 0 ? '' : `You have no ${c.item}: buy some in the Market`}">Give ${give || ''}</button>` : ''}</div></div>`;
    }
    return html;
  }

  /** the week goal: progress towards ★★★, the day, and the stars when it ends */
  private goalOver = false;
  private goalHtml(): string {
    const me = this.me;
    if (!me || this.ch) return '';
    const gv = goalView(this.v, me.id);
    if (!gv) return '';
    if (gv.over && !this.goalOver) {
      this.toast(`Week over: ${'★'.repeat(gv.stars)}${'☆'.repeat(3 - gv.stars)} with ${fmt(gv.worth)} gold`);
      chime('deal');
    }
    this.goalOver = gv.over;
    const stars = [0, 1, 2].map((i) => `<span class="${i < gv.stars ? 'on' : ''}" title="${fmt(gv.targets[i], 0)} gold">★</span>`).join('');
    const ticks = gv.targets.map((t) => `<i style="left:${Math.min(100, (t / gv.target) * 100)}%"></i>`).join('');
    return `<div class="goal ${gv.over ? 'over' : ''}" title="Net worth = your gold + your goods at the market price. ★ ${gv.targets.map((t) => fmt(t, 0)).join(' · ')} gold">
      <div class="goal-head"><span>🎯 ${esc(gv.title)}</span><span class="stars">${stars}</span></div>
      <div class="goal-bar"><b style="width:${(gv.progress * 100).toFixed(1)}%"></b>${ticks}</div>
      ${gv.rival ? `<div class="goal-rival small ${gv.gain >= gv.rival.gain ? 'ahead' : 'behind'}" title="Silas is an AI trader playing your game against you: he buys dips, undercuts your stall listings by 2% and takes requests and big orders you leave open."><span>vs ${esc(gv.rival.name)} 🤖</span><span>you ${gv.gain >= 0 ? '+' : ''}${fmt(gv.gain)} · ${esc(gv.rival.name)} ${gv.rival.gain >= 0 ? '+' : ''}${fmt(gv.rival.gain)} ${gv.gain >= gv.rival.gain ? '▲' : '▼'}</span></div>` : ''}
      <div class="goal-foot small"><span>${fmt(gv.worth)} / ${fmt(gv.target, 0)} gold</span><span>${gv.over ? `<button class="linkish" data-goal>New week</button>` : `day ${gv.day}/${gv.days}${gv.next ? ` · next ★ at ${fmt(gv.next, 0)}` : ''}`}</span></div>
    </div>`;
  }

  private renderQuests() {
    const me = this.me;
    if (!me) return;
    const done = QUESTS.filter((q) => me.quests[q.id]).length;
    const el = $('#quests');
    const today = (this.v.s.requests ?? []).filter((r) => r.day === this.v.day || (r.due !== undefined && (this.v.day <= r.due || r.missed)));
    const open = today.filter((r) => !r.by && !r.missed).length;
    const next = QUESTS.find((q) => !me.quests[q.id]);
    const head = `<button class="qhead" data-qtoggle title="${this.questsOpen ? 'Hide' : 'Show'} quests and requests">` +
      `<span>Quests</span><span class="muted">${next ? `${done}/${QUESTS.length}` : ''}${open ? `${next ? ' · ' : ''}${open} request${open > 1 ? 's' : ''}` : ''}${me.badges?.length ? ` · ★${me.badges.length}` : ''}</span><span>${this.questsOpen ? '▾' : '▸'}</span></button>`;
    const job = (this.v.s.keepers ?? []).filter((k) => k.player === me.id && (k.status === 'working' || this.v.day - (k.reports.at(-1)?.day ?? 0) <= 1)).at(-1);
    const last = job?.reports.at(-1);
    const goal = this.goalHtml() + this.socialHtml() + (last ? `<div class="kline small" title="${esc(last.text)}" data-kopen>${(() => { const f = this.face(job!.npc); return f ? `<img class="face" src="${f}" alt="">` : ''; })()}<span>${esc(last.text.length > 110 ? `${last.text.slice(0, 108)}…` : last.text)}</span></div>` : '');
    el.classList.toggle('hidden', !goal && !next && !today.length && !me.badges?.length);
    el.classList.toggle('closed', !this.questsOpen);
    if (!this.questsOpen) { el.innerHTML = goal + head; return; }
    const starter = next
      ? `<div class="q" title="${QUESTS.map((q) => `${me.quests[q.id] ? '✓' : '○'} ${q.text}`).join('\n')}">○ ${esc(next.text)} <span class="muted">+${fmt(RULES.questReward, 0)}</span></div>`
      : '';
    const reqs = today.map((r) => {
      const f = this.face(r.npc);
      const name = NPC_DEFS[r.npc].name;
      const who = r.by ? (r.by === me.id ? 'you' : this.v.s.players[r.by]?.name ?? 'someone') : '';
      const have = me.stock[r.item];
      if (r.due !== undefined) {
        // a big order: accept first, deliver by the due day, or the NPC remembers
        const left = r.due - this.v.day;
        const mine = r.takenBy === me.id;
        const taker = r.takenBy ? (mine ? 'you' : esc(this.v.s.players[r.takenBy]?.name ?? 'someone')) : '';
        const tip = `${name}: ${r.text}. Pays ${fmt(r.price)} each + ${fmt(r.bonus, 0)} bonus. Accept to take it on: deliver in time and ${name} remembers it twice; miss it and ${name}'s prices for you go up 2%.${this.v.s.players['ai-rival'] ? ' Leave it untaken for a day and Silas, the AI rival, takes it.' : ''}`;
        const state = r.by ? `✓ ${esc(who)}` : r.missed ? `✗ missed${taker ? ` by ${taker}` : ''}` : `${fmt(r.price)} each +${fmt(r.bonus, 0)} · ${left ? `${left + 1} days left` : 'due tonight'}${taker ? ` · taken by ${taker}` : ''}`;
        const btn = r.by || r.missed ? ''
          : !r.takenBy ? `<button class="mini" data-accept="${r.id}" title="Promise ${name} the goods">Accept</button>`
          : mine ? `<button class="mini" data-req="${r.id}" ${have < r.qty ? 'disabled' : ''} title="${have < r.qty ? `You have ${have} ${r.item}` : 'Hand the goods over'}">${have}/${r.qty}<br>Deliver</button>` : '';
        return `<div class="req big ${r.by ? 'done' : ''} ${r.missed ? 'missed' : ''}" title="${esc(tip)}">${f ? `<img class="face" src="${f}" alt="">` : '<span></span>'}` +
          `<div class="rtext"><b>${esc(name)}</b> · <span class="bigtag">big order</span> ${r.qty} ${icon(r.item, 12)} ${esc(r.item)}<div class="muted small">${state}</div></div>${btn}</div>`;
      }
      const tip = `${name}: ${r.text}. Pays ${fmt(r.price)} each + ${fmt(r.bonus, 0)} bonus; first delivery earns the badge "Friend of ${name}".${this.v.s.players['ai-rival'] ? ' Silas, the AI rival, fills open requests at 14:00: be first.' : ''}`;
      return `<div class="req ${r.by ? 'done' : ''}" title="${esc(tip)}">${f ? `<img class="face" src="${f}" alt="">` : '<span></span>'}` +
        `<div class="rtext"><b>${esc(name)}</b> · ${r.qty} ${icon(r.item, 12)} ${esc(r.item)}<div class="muted small">${r.by ? `✓ ${esc(who)}` : `${fmt(r.price)} each +${fmt(r.bonus, 0)} · ★`}</div></div>` +
        (r.by ? '' : `<button class="mini" data-req="${r.id}" ${have < r.qty ? 'disabled' : ''} title="${have < r.qty ? `You have ${have} ${r.item}: buy more in the Market` : 'Hand the goods over'}">${have}/${r.qty}<br>Deliver</button>`) +
        `</div>`;
    }).join('');
    const badges = me.badges?.length
      ? `<div class="badges">${me.badges.map((b) => `<span class="badge" title="Soulbound badge${b.tx ? ' · NEP-171 on NEAR testnet: see Prove on NEAR' : ''}">★ ${esc(b.title)}</span>`).join('')}</div>`
      : '';
    el.innerHTML = goal + head + starter + reqs + badges;
  }

  private onFeed(e: FeedEvent) {
    if (e.kind === 'season') this.toast(e.text);
    this.lastDay = this.v.day;
  }

  // ------------------------------------------------------------------ panels
  private renderPanel(force: boolean) {
    const el = $('#panel');
    if (!this.panel) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    // don't clobber an input the player is typing in, or a dropdown that is open
    if (!force && el.contains(document.activeElement) && ['INPUT', 'SELECT'].includes((document.activeElement as HTMLElement).tagName)) return;
    const body = this.panel === 'account' ? this.accountPanel()
      : this.panel === 'proof' ? this.proofPanel()
      : this.panel === 'market' ? this.marketPanel()
      : this.panel === 'guild' ? this.guildPanel()
      : this.panel === 'economy' ? this.economyPanel()
      : this.npcPanel();
    el.innerHTML = `<button class="close" data-act="close">×</button>${body}`;
    if (this.panel === 'npc') {
      const c = el.querySelector<HTMLCanvasElement>('canvas.portrait');
      if (c) this.portrait(this.npc, c);
    }
  }

  private spark(values: number[]) {
    if (values.length < 2) return '<svg class="spark"></svg>';
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * 96},${22 - ((v - lo) / (hi - lo || 1)) * 18}`).join(' ');
    return `<svg class="spark" viewBox="0 0 96 24"><polyline points="${pts}"/></svg>`;
  }

  private marketPanel() {
    const rows = marketView(this.v);
    const f = this.orderForm;
    const orderable = ['ore', 'timber', 'wheat', 'bread', 'tools', 'sword'] as ItemId[];
    const row = rows.find((r) => r.item === f.item)!;
    if (!f.maxPrice) f.maxPrice = Math.round(row.village * 1.1);
    const producer = NPC_DEFS[this.v.producerOf(f.item)!];
    const lo = f.qty * row.village;
    const hi = f.qty * f.maxPrice;
    const me = this.me;
    const gl = me?.guild ? this.v.s.guilds[me.guild] : null;
    const leader = gl?.leader === me?.id;
    const myOrders = this.v.s.orders.filter((o) => o.by.id === me?.id || (gl && o.by.id === gl.id)).slice(-5).reverse();
    const recipe = f.item === 'sword' ? '2 ore + 1 timber' : f.item === 'tools' ? '1 ore + 1 timber → 2' : f.item === 'bread' ? '1 wheat' : 'raw';
    return `
<div class="grid-2">
  <section class="pcard">
    <h3>Market · gold per unit</h3>
    <table class="mkt">
      <thead><tr><th>Item</th><th>Village</th><th>World</th><th>24h</th><th>7 days</th><th>Stock</th><th></th></tr></thead>
      <tbody>${rows.map((r: MarketRow) => `
        <tr>
          <td>${icon(r.item)} ${esc(r.name)}</td>
          <td>${fmt(r.village)}</td>
          <td class="world">${r.world ? fmt(r.world) : '—'}</td>
          <td class="${r.change24h > 0 ? 'up' : r.change24h < 0 ? 'down' : ''}">${pct(r.change24h)}</td>
          <td>${this.spark(r.spark)}</td>
          <td><div class="bar"><span style="width:${Math.min(100, (r.stock / (r.target * 2)) * 100)}%"></span></div></td>
          <td class="btns"><button data-act="buy" data-item="${r.item}" title="Buy 1 at ${fmt(r.ask)} + fee">Buy</button><button data-act="sell" data-item="${r.item}" title="Sell 1 at ${fmt(r.bid)} - fee" ${me && me.stock[r.item] > 0 ? '' : 'disabled'}>Sell</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="muted small">World price includes shipping. When the gap exceeds the band, Bruno imports or exports. Market fee ${(RULES.feeBps / 100).toFixed(1)}%: half to the season pool, half burned.</p>
    <p class="small">Your stock: ${ITEMS.filter((i) => me?.stock[i]).map((i) => `${icon(i, 14)} ${me!.stock[i]}`).join(' &nbsp;') || '<span class="muted">nothing yet</span>'}</p>
  </section>
  <section class="pcard">
    <h3>Place order</h3>
    <div class="order-head">${icon(f.item, 40)}<div><b>${esc(ITEM_DEFS[f.item].name)}</b><div class="muted small">${esc(producer.title)}: ${esc(producer.name)} · ${recipe}</div></div></div>
    <form class="kv">
      <label>Item <select name="item">${orderable.map((i) => `<option value="${i}" ${i === f.item ? 'selected' : ''}>${ITEM_DEFS[i].name}</option>`).join('')}</select></label>
      <label>Quantity <input name="qty" type="number" min="1" max="50" value="${f.qty}"></label>
      <label>Max price each <input name="maxPrice" type="number" min="0.1" step="0.1" value="${fmt(f.maxPrice)}"></label>
      <label>Deadline <select name="deadline">${[1, 2, 3, 5, 7].map((d) => `<option value="${d}" ${d === f.deadline ? 'selected' : ''}>${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select></label>
      <label>Paid by <select name="fromGuild"><option value="0">Me</option>${leader ? `<option value="1" ${f.fromGuild ? 'selected' : ''}>${esc(gl!.name)} fund</option>` : ''}</select></label>
      <div class="kvrow"><span>Estimate incl. fee</span><b class="gold">${fmt(lo + fee(lo))} – ${fmt(hi + fee(hi))}</b></div>
    </form>
    <p class="muted small">Gold is locked in the contract until delivery. Refunded if the deadline passes.</p>
    <div class="row"><button class="primary" data-act="order">Order ${f.qty} × ${esc(ITEM_DEFS[f.item].name.toLowerCase())}</button></div>
    ${myOrders.length ? `<h4>Your orders</h4>${myOrders.map((o) => `<div class="kvrow small"><span>#${o.id} ${o.qty}× ${o.item} · max ${fmt(o.maxPrice)}</span><span>${o.status === 'open' ? `${o.filled}/${o.qty} · due day ${o.deadlineDay} <button data-act="cancel" data-id="${o.id}">Cancel</button>` : o.status}</span></div>`).join('')}` : ''}
    <p class="muted small">Every trade shows where it stands (simulated, queued, on chain, failed, or kept in the game and reconciled): <button class="linkish" data-act="prove">⛓ Prove on NEAR</button></p>
  </section>
</div>
${this.stallBoard()}`;
  }

  /** Player listings: goods in escrow at a fixed price; NPCs check the board at 11:00 and 16:00. */
  private stallBoard() {
    const v = this.v;
    const me = this.me;
    const lf = this.listForm;
    const held = ITEMS.filter((i) => (me?.stock[i] ?? 0) > 0);
    if (held.length && !held.includes(lf.item)) {
      lf.item = held[0];
      lf.price = 0;
    }
    const mid = midPrice(lf.item, v.s.market.stock[lf.item]);
    const price = lf.price || mid; // follows the market until the player types a price
    lf.qty = Math.max(1, Math.min(lf.qty, RULES.listingMaxQty, me?.stock[lf.item] || 1));
    const open = (v.s.listings ?? []).filter((l) => l.status === 'open');
    const recent = (v.s.listings ?? []).filter((l) => l.status === 'sold' && v.day - l.day <= 2).slice(-4).reverse();
    const nameOf = (id: string) => (id === me?.id ? 'you' : esc(v.s.players[id]?.name ?? id));
    const buyerOf = (l: (typeof recent)[number]) => (l.buyer?.kind === 'npc' ? NPC_DEFS[l.buyer.id as NpcId].name : l.buyer ? nameOf(l.buyer.id) : '?');
    const vsMarket = (item: ItemId, price: number) => {
      const p = price / midPrice(item, v.s.market.stock[item]) - 1;
      return `<span class="${p < 0 ? 'down' : p > 0 ? 'up' : ''}">${pct(p)}</span>`;
    };
    const onChain = this.src.chain === 'near';
    return `
<section class="pcard stall-board">
  <h3>Stall board · players sell to NPCs</h3>
  <p class="muted small">List goods at your price. Crafters buy a listing when it beats the market's ask and they need it today; Bruno buys anything at least 5% under what the market pays, to resell. They check the board at 11:00 and 16:00. Unsold listings go home after ${RULES.listingDays} days. ${onChain ? 'With the stalls contract on, your goods wait in its escrow and the buyer pays through it.' : ''}</p>
  ${open.length ? `<table class="mkt"><thead><tr><th>Seller</th><th>Goods</th><th>Each</th><th>vs market</th><th>Total</th><th></th></tr></thead><tbody>${open.map((l) => `
    <tr><td>${nameOf(l.seller)}</td><td>${icon(l.item)} ${l.qty} ${esc(l.item)}</td><td>${fmt(l.price, 2)}</td><td>${vsMarket(l.item, l.price)}</td><td>${fmt(l.price * l.qty)}</td>
    <td>${l.seller === me?.id ? `<button data-act="unlist" data-id="${l.id}">Cancel</button>` : me ? `<button data-act="buy-listing" data-id="${l.id}" ${me.gold >= l.price * l.qty ? '' : 'disabled'}>Buy all</button>` : ''} ${l.tx ? this.txState(l.tx) : ''}</td></tr>`).join('')}</tbody></table>`
    : '<div class="muted small">No open listings.</div>'}
  ${recent.length ? `<div class="small">${recent.map((l) => `<div class="kvrow"><span>${buyerOf(l)} bought ${l.seller === me?.id ? 'your' : `${nameOf(l.seller)}'s`} ${l.qty} ${esc(l.item)} at ${fmt(l.price, 2)}</span><span>${l.saleTx ? this.txState(l.saleTx) : ''}</span></div>`).join('')}</div>` : ''}
  ${me ? held.length ? `
  <form class="kv row-form">
    <label>Item <select name="lItem">${held.map((i) => `<option value="${i}" ${i === lf.item ? 'selected' : ''}>${ITEM_DEFS[i].name} (${me.stock[i]})</option>`).join('')}</select></label>
    <label>Quantity <input name="lQty" type="number" min="1" max="${Math.min(RULES.listingMaxQty, me.stock[lf.item])}" value="${lf.qty}"></label>
    <label>Price each <input name="lPrice" type="number" min="${fmt(Math.ceil(mid * 0.5))}" max="${fmt(mid * 2)}" step="0.01" value="${fmt(price, 2)}"></label>
    <div class="kvrow"><span>Market now ${fmt(mid, 2)} · you ask ${vsMarket(lf.item, price)}</span><button class="primary" data-act="list">List ${lf.qty} ${esc(lf.item)}</button></div>
  </form>` : '<div class="muted small">Buy or make something first, then list it here.</div>' : ''}
  ${me ? this.keeperCard(held) : ''}
</section>`;
  }

  /** Hire an NPC to keep your stall: it prices and sells by the strategy you pick, then reports. */
  private keeperCard(held: ItemId[]) {
    const v = this.v;
    const me = this.me!;
    const job = (v.s.keepers ?? []).filter((k) => k.player === me.id).at(-1);
    const working = job?.status === 'working';
    const reports = job ? job.reports.slice(-3).reverse().map((r) => `<div class="kreport"><span class="muted">${r.day === v.day ? 'today' : r.day === v.day - 1 ? 'yesterday' : `${v.day - r.day} days ago`}</span> ${esc(r.text)}</div>`).join('') : '';
    const kf = this.keeperForm;
    const lf = this.listForm;
    const hireable = NPCS.filter((id) => id !== 'bruno');
    const strat: [KeeperStrategy, string, string][] = [
      ['quick', 'Sell fast', 'just under what Bruno pays: gone at 11:00'],
      ['hold', 'Hold the price', 'the market price, for a crafter who needs it'],
      ['wait', 'Wait for a rise', 'holds out above the market while the world says prices rise; sells fast on the last day'],
    ];
    const face = (id: NpcId) => { const f = this.face(id); return f ? `<img class="face" src="${f}" alt="">` : ''; };
    return `<div class="keeper">
    <h4>Hire a stall keeper ${working ? `<span class="muted">· ${face(job!.npc)}${NPC_DEFS[job!.npc].name} is working: ${job!.left} ${esc(job!.item)} left, ${job!.strategy}</span>` : ''}</h4>
    ${working ? `<div class="row"><button data-act="dismiss-keeper" data-id="${job!.id}">Send ${NPC_DEFS[job!.npc].name} home</button></div>`
      : held.length ? `<p class="muted small">An NPC sells your goods while you are away: ${RULES.keeperCommissionBps / 100}% of each sale, ${RULES.keeperDays} days, a report every evening at 20:00 with what it sold and why.</p>
    <div class="keeper-pick">${hireable.map((id) => `<button class="${id === kf.npc ? 'active' : ''}" data-act="keeper-npc" data-id="${id}">${face(id)}${NPC_DEFS[id].name}</button>`).join('')}</div>
    <div class="keeper-strat">${strat.map(([k, label, tip]) => `<button class="${k === kf.strategy ? 'active' : ''}" data-act="keeper-strat" data-id="${k}" title="${esc(tip)}"><b>${label}</b><span class="muted small">${esc(tip)}</span></button>`).join('')}</div>
    <div class="row"><button class="primary" data-act="hire-keeper">Hire ${NPC_DEFS[kf.npc].name}: sell ${lf.qty} ${esc(lf.item)}</button><span class="muted small">item and quantity from the form above</span></div>`
      : ''}
    ${reports}
  </div>`;
  }

  /** Every transaction that touched the player: their own (relayed) calls and NPC fills of their orders. */
  private myTxRows(n: number) {
    const me = this.me;
    if (!me) return [];
    const signer = playerSigner(me.id);
    const mine = new Set(this.v.s.orders.filter((o) => o.by.kind === 'player' && o.by.id === me.id).map((o) => o.id));
    // purchases of my stall-board listings (an NPC's npc_stall_buy, or another player's buy)
    const listed = new Set((this.v.s.listings ?? []).filter((l) => l.seller === me.id).map((l) => l.id));
    return this.v.s.txs
      .filter((t) => t.signer === signer
        || (t.method === 'fill_order' && mine.has(Number(t.args.order_id)))
        || ((t.method === 'npc_stall_buy' || t.method === 'buy_listing') && listed.has(Number(t.args.listing_id))))
      .slice(-n)
      .reverse();
  }

  private txWhat(t: { signer: string; method: string; args: Record<string, unknown> }) {
    const a = t.args;
    const by = this.me && t.signer === playerSigner(this.me.id) ? '' : ` by ${esc(t.signer.split('.')[0])}`;
    if (t.method === 'npc_stall_buy' || (t.method === 'buy_listing' && by)) {
      const l = (this.v.s.listings ?? []).find((x) => x.id === Number(a.listing_id));
      const mine = l && this.me && l.seller === this.me.id;
      return `${esc(t.signer.split('.')[0].replace(/^./, (c) => c.toUpperCase()))} bought ${mine ? 'your' : 'a'} listing${l ? ` · ${l.qty} ${esc(l.item)}` : ''}`;
    }
    return `${esc(t.method.replace(/^relay_/, '').replace(/_/g, ' '))}${a.qty ? ` ${a.qty}` : ''}${a.item ? ` ${esc(String(a.item))}` : ''}${by}`;
  }

  /**
   * One transaction's state (simulated / queued / finalized / failed / reconciled). Only a
   * real hash gets an explorer link; nothing else is dressed up as on chain.
   */
  private txState(hash: string) {
    const st = this.src.chain !== 'near' ? 'simulated' : txState(hash);
    const hint = esc(TX_STATE_HINT[st]);
    switch (st) {
      case 'finalized': return `<span class="txs ok" title="${hint}">on chain</span> <a class="tx" target="_blank" rel="noopener" href="${EXPLORER}/txns/${esc(hash)}">${esc(short(hash))} ↗</a>`;
      case 'failed': {
        const why = hash.slice('failed:'.length);
        return `<span class="txs bad" title="${esc(why || hint)}">failed</span>${why ? ` <span class="muted small">${esc(why.slice(0, 40))}</span>` : ''}`;
      }
      case 'queued': return `<span class="txs" title="${hint}">queued…</span>`;
      case 'reconciled': return `<span class="txs" title="${hint}">kept in game · reconciled</span>`;
      default: return `<span class="txs" title="${hint}">simulated</span>`;
    }
  }

  private txRowsHtml(rows: { t: number; signer: string; method: string; args: Record<string, unknown>; ok: boolean; hash: string }[]) {
    return rows.map((t) => `<div class="kvrow small"><span>${hh(t.t)} · ${this.txWhat(t)}</span><span>${t.ok ? '' : '<span class="down">refused</span> '}${this.txState(t.hash)}</span></div>`).join('');
  }

  /**
   * Everything that touched NEAR in one place, so the game itself never shows hashes:
   * the player's own trades, badges, the agents' latest calls and the red-team refusals.
   */
  private proofPanel() {
    const v = this.v;
    const me = this.me;
    const near = this.src.chain === 'near';
    const acct = this.src.account;
    const mine = this.myTxRows(12);
    const npcAccounts = new Set(NPCS.map((id) => NPC_DEFS[id].account));
    const agents = v.s.txs.filter((t) => npcAccounts.has(t.signer)).slice(-8).reverse();
    const badges = (me?.badges ?? []).map((b) => `<div class="kvrow small"><span>★ ${esc(b.title)}</span><span>${b.tx ? this.txState(b.tx) : '<span class="muted">not minted</span>'}</span></div>`).join('');
    const refusals = v.s.feed.filter((e) => e.kind === 'blocked' && e.tx && txKind(e.tx) === 'chain').slice(-4).reverse()
      .map((e) => `<div class="kvrow small"><span>${esc(stripTx(e.text).slice(0, 90))}</span><span>${this.txState(e.tx!)}</span></div>`).join('');
    const yours = `<h4>Your transactions</h4>${mine.length ? this.txRowsHtml(mine) : '<p class="muted small">Nothing yet: buy something in the Market or deliver a request.</p>'}
      ${badges ? `<h4>Your badges</h4>${badges}` : ''}`;
    if (near && acct) {
      return `
<div class="grid-2">
  <section class="pcard">
    <h3>⛓ Prove on NEAR</h3>
    <p class="small">Your market trades, orders, request deliveries, stall-board listings and badges are relayed to NEAR testnet; each row shows its state, and only real transactions get an explorer link. A listing's goods wait in the stalls contract's escrow; the NPC that buys it signs with its own key.</p>
    <p class="muted small">What stays in the game: guild-stall and guild trades, a hired keeper's commission, quest rewards, eating and upkeep. Every 10 real minutes (about 5 game days on the hosted village) the operator's <span class="mono">reconcile</span> writes the game's balances to the chain, so the chain's game day can trail the village by a few days and logs how much it changed. Claim your key (Account) and reconcile never touches your account again.</p>
    <p class="muted small"><b>Kept in game · reconciled</b> on an NPC row means the call was held back on purpose, not lost: the NPC's goods on chain were behind the game (a delivery or trade that stayed in the game, a call over its gas budget), so a craft or sale that would have failed is not sent. Before each craft the server reads the NPC's inputs on chain. The next <span class="mono">reconcile</span> catches the chain up. The dashboard's settlement funnel counts sent, landed, failed, held back and reconciled calls: <a href="./dashboard.html" target="_blank" rel="noopener">Live ↗</a></p>
    <div class="kvrow small"><span>Your account</span><a class="tx" target="_blank" rel="noopener" href="${EXPLORER}/address/${esc(acct)}">${esc(acct.slice(0, 10))}…${esc(acct.slice(-6))} ↗</a></div>
    <div class="kvrow small"><span>Game contract</span><a class="tx" target="_blank" rel="noopener" href="${EXPLORER}/address/${esc(NEAR_CONFIG.contract)}">${esc(NEAR_CONFIG.contract)} ↗</a></div>
    ${yours}
  </section>
  <section class="pcard">
    <h3>The agents on chain</h3>
    <p class="muted small">Each NPC signs with its own key, limited to a few game methods and a daily budget.</p>
    ${this.txRowsHtml(agents) || '<p class="muted small">No agent transactions yet today.</p>'}
    ${refusals ? `<h4>Attacks the contract refused</h4>${refusals}` : ''}
    <div class="row"><a class="btn" href="./dashboard.html" target="_blank" rel="noopener">Live economy and proof list ↗</a></div>
  </section>
</div>`;
    }
    const hist = this.proofHistory.slice(-8).reverse().map((e) => `<div class="kvrow small"><span>${esc(e.redTeam ? `Red-team attack refused by the contract${e.attack ? `: ${e.attack}` : ''}` : PROOF_LABEL[e.method] ?? e.method)}</span><a class="tx" target="_blank" rel="noopener" href="${EXPLORER}/txns/${esc(e.hash)}">${esc(short(e.hash))} ↗</a></div>`).join('');
    return `
<div class="grid-2">
  <section class="pcard">
    <h3>⛓ Prove on NEAR</h3>
    <p class="small">${this.src.mode === 'guest'
      ? 'This is the guest village: it runs in your browser, so its transactions are simulated. Sign in and the same actions are signed on NEAR testnet, under an account made for you (no wallet, no seed phrase).'
      : 'This server runs without the chain mirror, so its transactions stay simulated. The hosted village signs them on NEAR testnet.'}</p>
    ${this.hooks.signIn ? '<div class="row"><button class="primary" data-act="signin">Sign in with Google</button></div>' : ''}
    ${yours}
  </section>
  <section class="pcard">
    <h3>Already on NEAR testnet</h3>
    <p class="muted small">Real transactions from the hosted village on <span class="mono">${esc(NEAR_CONFIG.contract)}</span>:</p>
    ${hist || '<p class="muted small">loading…</p>'}
    <div class="row"><a class="btn" target="_blank" rel="noopener" href="${EXPLORER}/address/${esc(NEAR_CONFIG.contract)}">The contract on the explorer ↗</a></div>
  </section>
</div>`;
  }

  // ------------------------------------------------------------------ first trade, tour
  private firstTrade() {
    const key = `hm.first.${this.src.mode}`;
    if (LS.get(key)) return;
    LS.set(key, '1');
    this.receipt = true;
    this.renderReceipt();
  }

  /** After the first trade: its one or two transactions, and how they reach NEAR. */
  private renderReceipt() {
    const el = $('#receipt');
    if (!this.receipt) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const rows = this.myTxRows(2);
    const near = this.src.chain === 'near';
    el.innerHTML = `<button class="close" data-card="receipt-close">×</button>
      <h4>Your first trade</h4>
      ${this.txRowsHtml(rows)}
      ${near
        ? '<p class="small">Relayed to NEAR testnet for your account: queued first, then on chain with a link (or failed, and it says so).</p><div class="row"><button data-card="prove">⛓ Prove on NEAR</button><button data-card="receipt-close">Got it</button></div>'
        : `<p class="small">${this.src.mode === 'guest' ? 'In the online village this is a real NEAR testnet transaction, under an account made for you.' : 'This server runs without the chain mirror; the hosted village signs this on NEAR testnet.'}</p><div class="row">${this.hooks.signIn ? '<button class="primary" data-card="signin">Sign in with Google</button>' : ''}<button data-card="receipt-close">Keep playing</button></div>`}`;
  }

  private toggleTour(force?: boolean) {
    this.tour.open = force ?? !this.tour.open;
    if (this.tour.open && !this.tour.started) {
      this.tour.started = Date.now();
      this.tour.startDay = this.v.day;
    }
    LS.set('hm.tour', 'seen');
    this.renderTour();
  }

  /** The 3-minute judge tour: seven steps that tick themselves off as the player does them. */
  private renderTour() {
    const el = $('#tour');
    $('#tour-btn').classList.toggle('active', this.tour.open);
    if (!this.tour.open) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const me = this.me;
    const guest = this.src.mode === 'guest';
    const mine = this.myTxRows(50);
    if (me?.badges?.some((b) => b.title === 'Red Teamer')) this.tour.redTeamed = true;
    const sold = !!me && ((this.v.s.listings ?? []).some((l) => l.seller === me.id) || (this.v.s.keepers ?? []).some((k) => k.player === me.id));
    const steps: { done: boolean; text: string; go: string; label: string }[] = [
      { done: mine.some((t) => t.method.endsWith('market_buy') && t.ok), text: 'Buy 3 wheat in the Market', go: 'market', label: 'Market' },
      { done: this.tour.saw.haggle >= 2, text: 'Haggle with Mike: Push low, then Halfway. He comes down each round', go: 'haggle', label: 'Mike' },
      { done: sold, text: 'Sell on the stall board, or hire an NPC to keep your stall', go: 'stall', label: 'Stall' },
      guest
        ? { done: this.v.day >= this.tour.startDay + 7, text: 'Fast-forward 7 days: weather moves prices; Silas, the AI rival, races you', go: 'ffwd', label: '⏩' }
        : { done: this.v.day > this.tour.startDay, text: 'Let a day pass: the server runs the clock (guest mode has ⏩ 7 days)', go: 'dashboard', label: 'Live' },
      { done: this.tour.saw.npc && this.tour.saw.hover, text: 'Hover an NPC to see why it prices that way, then open it and read its Diary', go: 'npc', label: 'NPC' },
      { done: this.tour.redTeamed, text: 'Red team: tell an NPC to empty its wallet and watch the guard stop it', go: 'redteam', label: 'Attack' },
      { done: this.tour.saw.prove, text: 'Prove on NEAR: every transaction on the explorer', go: 'prove', label: '⛓' },
    ];
    for (const s of steps) {
      if (s.done) this.tour.done.add(s.go);
      else s.done = this.tour.done.has(s.go);
    }
    const done = steps.filter((s) => s.done).length;
    const secs = Math.round((Date.now() - this.tour.started) / 1000);
    el.innerHTML = `<button class="close" data-card="tour-close">×</button>
      <h4>3-minute tour <span class="muted">${done}/${steps.length}${done === steps.length ? ` · done in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}</span></h4>
      ${steps.map((s, i) => `<div class="tstep ${s.done ? 'done' : ''}"><span>${s.done ? '✓' : i + 1}</span><span>${esc(s.text)}</span>${s.done ? '' : `<button class="mini" data-card="go-${s.go}">${esc(s.label)}</button>`}</div>`).join('')}`;
  }

  /** Hovering an NPC on the map counts for the tour. */
  sawHover() {
    if (this.tour.saw.hover) return;
    this.tour.saw.hover = true;
    this.renderTour();
  }

  /**
   * A card button acts on pointerdown. preventDefault stops the mouse events that follow, so a
   * card that shrinks as it re-renders cannot pass the click to an NPC on the map behind it.
   */
  private cardDown(e: PointerEvent) {
    if (e.button !== 0 || !(e.target as HTMLElement).closest('[data-card]')) return;
    e.preventDefault();
    this.onCardClick(e);
  }

  private onCardClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-card]');
    if (!b) return;
    switch (b.dataset.card) {
      case 'receipt-close': this.receipt = false; this.renderReceipt(); break;
      case 'prove': case 'go-prove': this.receipt = false; this.renderReceipt(); if (this.panel !== 'proof') this.open('proof'); break;
      case 'signin': this.hooks.signIn?.(); break;
      case 'tour-close': this.toggleTour(false); break;
      case 'go-market': if (this.panel !== 'market') this.open('market'); break;
      case 'go-order': if (this.panel !== 'market') this.open('market'); $('[data-act="order"]', $('#panel'))?.scrollIntoView({ block: 'center' }); break;
      case 'go-haggle': this.open('npc', 'mike'); $('.haggle-chips', $('#panel'))?.scrollIntoView({ block: 'center' }); break;
      case 'go-stall': if (this.panel !== 'market') this.open('market'); $('.stall-board', $('#panel'))?.scrollIntoView({ block: 'start' }); break;
      case 'go-ffwd': document.getElementById('ffwd')?.click(); break;
      case 'go-dashboard': window.open('./dashboard.html', '_blank', 'noopener'); break;
      case 'ch-negotiate': {
        const c = this.ch;
        if (!c || this.chBusy) break;
        const pitch = ($('[name="pitch"]', $('#challenge')) as HTMLInputElement | null)?.value ?? '';
        this.chBusy = true;
        this.renderChallenge();
        void this.negotiateContract(c, pitch).finally(() => {
          this.chBusy = false;
          this.render();
        });
        break;
      }
      case 'ch-deliver': {
        const r = this.ch?.deliver();
        if (r) this.toast(r.ok ? r.info ?? 'Delivered' : r.reason, !r.ok);
        this.render();
        break;
      }
      case 'go-npc': this.open('npc', 'mike'); break;
      case 'go-redteam': this.open('npc', 'bruno'); $('[name="attack"]', $('#panel'))?.scrollIntoView({ block: 'center' }); break;
    }
  }

  private guildPanel() {
    const v = this.v;
    const me = this.me;
    const ranking = v.ranking();
    const gl = me?.guild ? v.s.guilds[me.guild] : null;
    const myRank = gl ? ranking.findIndex((r) => r.guild === gl.id) : -1;
    const daysLeft = RULES.seasonDays - v.seasonDay;
    const pool = v.s.seasonPool;
    const earns = myRank >= 0 && myRank < 10 ? Math.floor((pool * RULES.seasonSplitBps[myRank]) / 10_000) : 0;
    const invs = gl ? v.s.investments.filter((i) => !i.settled && i.investor.kind === 'guild' && i.investor.id === gl.id) : [];
    const leader = gl?.leader === me?.id;
    const rankRows = ranking.slice(0, 10).map((r, i) => `<tr class="${gl && r.guild === gl.id ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.name)}</td><td class="${r.score >= 0 ? 'up' : 'down'}">${pct(r.score, 1)}</td><td>${r.members}</td><td>${r.eligible ? '🏅' : '<span class="muted small">needs 3 active</span>'}</td></tr>`).join('');
    const mine = gl
      ? `<h3>${esc(gl.name)} fund · ${gl.members.length} members</h3>
        <div class="kvrow"><span>Capital</span><b>${fmt(gl.fund, 0)}</b></div>
        ${invs.map((i) => `<div class="kvrow"><span>Invested in ${NPC_DEFS[i.npc].name}</span><span>${fmt(i.principal, 0)} · paid ${fmt(i.paid, 1)} · day ${i.matureDay}</span></div>`).join('')}
        ${ITEMS.filter((i) => gl.stock[i]).map((i) => `<div class="kvrow"><span>Holding ${icon(i, 14)} ${i}</span><span>${gl.stock[i]}</span></div>`).join('')}
        <div class="row"><input name="deposit" type="number" min="1" value="10" class="short"> <button data-act="deposit">Deposit gold</button></div>
        ${gl.vote ? `<div class="vote"><div class="kvrow"><span>Open vote</span><b>${esc(gl.vote.text)}</b></div><div class="muted small">${gl.vote.yes.length} yes · ${gl.vote.no.length} no · passes with a majority of ${gl.members.length}</div><div class="row"><button class="primary" data-act="vote-yes">Approve</button><button data-act="vote-no">Reject</button></div></div>`
          : `<div class="row"><button data-act="propose-wheat">Propose: buy 20 wheat</button><button data-act="propose-invest">Propose: invest 20% in Theo</button></div>`}
        ${leader ? '<p class="muted small">You lead this guild: you can spend the fund directly from the market and order forms.</p>' : ''}`
      : `<h3>Join a guild</h3>
        <p class="muted small">A guild is a shared fund (3–20 members). Members vote on which NPCs to back and what to order. Return on the fund decides the season ranking.</p>
        ${Object.values(v.s.guilds).map((x) => `<div class="kvrow"><span>${esc(x.name)} · ${x.members.length} members</span><button data-act="join" data-id="${x.id}">Join</button></div>`).join('')}
        <div class="row"><input name="gname" placeholder="New guild name" class="short"><button class="primary" data-act="create">Found a guild</button></div>`;
    const stalls = v.s.stalls.map((st) => {
      const owner = st.guild ? v.s.guilds[st.guild] : null;
      const prices = Object.keys(st.sell).map((i) => `${icon(i as ItemId, 14)} buy ${fmt(st.buy[i as ItemId]!)} / sell ${fmt(st.sell[i as ItemId]!)}`).join(' · ');
      return `<div class="kvrow small"><span>Stall ${st.slot + 1}: ${owner ? esc(owner.name) : '<span class="muted">for rent</span>'}</span><span>${owner ? `${prices || 'no prices'} · P/L ${fmt(st.profit, 0)}` : gl && leader ? `<button data-act="rent" data-id="${st.slot}">Rent ${fmt(RULES.stallRent, 0)}</button>` : ''}</span></div>`;
    }).join('');
    return `
<div class="grid-3">
  <section class="pcard">
    <h3>Season ${v.s.season} ranking · ${daysLeft} days left</h3>
    <table class="rank"><thead><tr><th>#</th><th>Guild</th><th>Return</th><th>Mbr</th><th></th></tr></thead><tbody>${rankRows}</tbody></table>
    <p class="muted small">Top 10 share the season pool. Score = profit % on the fund, so a small smart guild beats a big rich one.</p>
  </section>
  <section class="pcard">
    <h3>Season pool</h3>
    <div class="big gold">${fmt(pool, 0)} gold</div>
    <div class="muted small">0.75% of ${fmt(v.s.ledger.volume, 0)} gold traded + stall rent</div>
    ${myRank >= 0 ? `<div class="kvrow"><span>Rank ${myRank + 1} currently earns</span><b class="gold">${fmt(earns, 0)} gold</b></div>` : ''}
    <hr>${mine}
  </section>
  <section class="pcard">
    <h3>Market stalls</h3>${stalls}
    <p class="muted small">Stall owners post buy and sell prices. NPCs compare them with the market and pick the better deal.</p>
    <hr>
    <h3>Market war <span class="tag">if time allows</span></h3>
    <p class="muted small">Guild A challenges guild B on one item for 24h; each side pushes the price its way through real trades. 1 war/day, ±20% band. Not in this build yet.</p>
    <h3>Badge <span class="tag">if time allows</span></h3>
    <p class="muted small">Top 10 earn a non-transferable NEP-171 NFT: “Hearthmarket · Season ${v.s.season} · Rank N · Guild”.</p>
  </section>
</div>`;
  }

  private chart(title: string, values: number[], color: string, baseline?: number) {
    if (values.length < 2) return `<div class="chart muted small">${title}: waiting for day 2…</div>`;
    const lo = Math.min(...values, baseline ?? Infinity);
    const hi = Math.max(...values, baseline ?? -Infinity);
    const pad = (hi - lo) * 0.15 || 1;
    const y = (n: number) => 110 - ((n - lo + pad) / (hi - lo + 2 * pad)) * 100;
    const x = (i: number) => 10 + (i / (values.length - 1)) * 280;
    const pts = values.map((n, i) => `${x(i)},${y(n)}`).join(' ');
    const base = baseline !== undefined ? `<line x1="10" x2="290" y1="${y(baseline)}" y2="${y(baseline)}" class="baseline"/>` : '';
    const labels = values.map((_, i) => (values.length <= 10 || i % Math.ceil(values.length / 8) === 0 ? `<text x="${x(i)}" y="128">D${i + 1}</text>` : '')).join('');
    return `<svg class="chart" viewBox="0 0 300 132">${base}<polyline points="${pts}" style="stroke:${color}"/>${labels}</svg>`;
  }

  private economyPanel() {
    const st = this.v.s.dailyStats;
    const supply = st.map((d) => d.goldSupply / 100);
    const idx = st.map((d) => (d.priceIndex / (st[0]?.priceIndex || 100)) * 100);
    const a = st.at(-2)?.ledger;
    const b = st.at(-1)?.ledger;
    const d = (f: (l: NonNullable<typeof b>) => number) => (a && b ? f(b) - f(a) : b ? f(b) : 0);
    const growth = supply.length > 1 ? (supply.at(-1)! - supply.at(-2)!) / supply.at(-2)! : 0;
    const idxRange = idx.length ? `${Math.min(...idx).toFixed(0)}–${Math.max(...idx).toFixed(0)}` : '—';
    const flows = [
      ['Faucet', 'Bruno exports', 'NPC sales to the world', d((l) => l.faucets.exports)],
      ['Faucet', 'Adventurers', 'outside buyers of swords', d((l) => l.faucets.adventurers)],
      ['Faucet', 'Quests + new players', 'tutorial rewards, starting gold', d((l) => l.faucets.quests + l.faucets.signup)],
      ['Sink', 'Market fee burn', '0.75% of trades', -d((l) => l.sinks.feeBurn)],
      ['Sink', 'Imports', 'gold paid to the world', -d((l) => l.sinks.imports)],
      ['Sink', 'Upkeep', 'NPC workshops', -d((l) => l.sinks.upkeep)],
    ] as const;
    const health = economyHealth(st);
    const goods = b ? `${b.toolsWorn} tools worn out · ${b.breadEaten} bread eaten` : '';
    return `
<div class="grid-3">
  <section class="pcard"><h3>Gold supply · gold</h3>${this.chart('Gold supply', supply, '#e3a83b')}<p class="muted small">${supply.length > 1 ? `${pct(growth, 1)} yesterday` : ''}</p></section>
  <section class="pcard"><h3>Village price index · day 1 = 100</h3>${this.chart('Price index', idx, '#8db8ff', 100)}<p class="muted small">Range so far: ${idxRange}</p>
    <h3>Health <span class="txs ${health.status === 'stable' ? 'ok' : health.status === 'collecting' ? '' : 'bad'}">${esc(health.status)}</span></h3>
    <p class="small">${esc(health.text)}</p>
    ${health.seasons.length > 1 ? health.seasons.map((x) => `<div class="kvrow small"><span>Season ${x.season} · ${x.days} days</span><span class="mono">index ${x.avgIndex.toFixed(1)} · supply ${pct(x.supplyChange, 1)}</span></div>`).join('') : ''}</section>
  <section class="pcard"><h3>Yesterday's flows · gold</h3>
    ${flows.map(([k, n, why, val]) => `<div class="kvrow"><span><b>${n}</b> <span class="muted small">${why}</span></span><b class="${val >= 0 ? 'up' : 'down'}">${val >= 0 ? '+' : ''}${fmt(val, 0)}</b></div>`).join('')}
    <div class="muted small">Goods sinks so far: ${goods}</div>
    <div class="sim"><h4>Simulation report</h4><p class="small">${esc(this.simSummary ?? '30 simulated days, 4 AI guilds, 50 bot players. Run `npm run sim` to regenerate.')}</p><div class="muted small">Full report: <span class="mono">docs/economy-sim.md</span> in the repo</div></div>
  </section>
</div>`;
  }

  private accountPanel() {
    const me = this.me;
    const acct = this.src.account;
    if (this.src.mode === 'guest' || !acct) {
      return `<section class="pcard"><h3>Your NEAR account</h3><p>Guest mode runs in your browser and has no account. Sign in with Google in the online village and a NEAR account is made for you: no wallet, no seed phrase. You can claim it into a real wallet any time.</p></section>`;
    }
    const k = this.claimed;
    const canClaim = this.src.authKind === 'google' && !!this.src.claim;
    return `
<div class="grid-2">
  <section class="pcard">
    <h3>Your NEAR account</h3>
    <div class="mono small break">${esc(acct)}</div>
    <p class="small">An implicit account on NEAR testnet, derived from your Google sign-in: the same Google account always gets the same NEAR account. Your gold is the NEP-141 token <span class="mono">HGOLD</span> on <span class="mono">${esc(NEAR_CONFIG.contract)}</span>; quest and season badges are NEP-171 tokens.</p>
    <div class="kvrow"><span>Gold in the village</span><b class="gold">${fmt(me?.gold ?? 0)}</b></div>
    <div class="kvrow"><span>Badges</span><span>${me?.badges?.length ?? 0}</span></div>
    <div class="row"><button data-act="prove">⛓ Prove on NEAR</button></div>
  </section>
  <section class="pcard">
    <h3>Claim it into your own wallet</h3>
    ${k ? `
    <p class="small down"><b>Your private key.</b> Anyone with it controls this account. Do not share it, screenshot it or paste it into a chat.</p>
    <div class="secret mono">${esc(k.privateKey)}</div>
    <div class="row"><button class="primary" data-act="copy-key">Copy key</button><button data-act="hide-key">Hide</button></div>
    <ol class="small steps">
      <li>Open a NEAR wallet that imports private keys (for example Meteor Wallet), switch it to <b>testnet</b>, choose <b>Import account → Private key</b> and paste the key.</li>
      <li>The account only appears on chain once it holds a little NEAR for gas: send it 0.05 testnet NEAR from any testnet account or faucet.</li>
      <li>From then on you can move your HGOLD yourself: <span class="mono">ft_transfer</span> on <span class="mono">${esc(k.contract)}</span>.</li>
    </ol>
    <p class="muted small">Until you claim, the game's operator relays your trades for you. That convenience stays on after you claim: the contract lets the operator place trades and orders for registered players, never transfer their gold out.</p>`
    : canClaim ? `
    <p class="small">The game made this account for you so you could play without a wallet. You can take the key and use the account anywhere, outside this game too.</p>
    <button class="primary" data-act="claim">Reveal my private key</button>
    ${this.claimError ? `<p class="small down">${esc(this.claimError)}</p>` : ''}`
    : '<p class="small">Only accounts made from a Google sign-in can be claimed. Typed-email logins (development) have no proof of who you are.</p>'}
  </section>
</div>`;
  }

  private npcPanel() {
    const v = this.v;
    const id = this.npc;
    const def = NPC_DEFS[id];
    const n = v.s.npcs[id];
    const invs = v.s.investments.filter((i) => !i.settled && i.npc === id);
    const guilds = new Set(invs.filter((i) => i.investor.kind === 'guild').map((i) => i.investor.id)).size;
    const players = new Set(invs.filter((i) => i.investor.kind === 'player').map((i) => i.investor.id)).size;
    const txs = v.s.txs.filter((t) => t.signer === def.account).slice(-7).reverse();
    const diary = v.s.diary.filter((d) => d.npc === id).slice(-2).reverse();
    const hungerPct = Math.max(0, 100 - n.hunger * 25);
    const spentPct = Math.min(100, (n.spentToday / def.dailyBudget) * 100);
    const blocked = txs.find((t) => !t.ok);
    const tabs = NPCS.map((x) => {
      const f = this.face(x);
      return `<button class="${x === id ? 'active' : ''}" data-act="npc" data-id="${x}">${f ? `<img class="face" src="${f}" alt="">` : ''}${NPC_DEFS[x].name}</button>`;
    }).join('');
    return `
<div class="npc-tabs">${tabs}</div>
<div class="grid-3">
  <section class="pcard center">
    <canvas class="portrait" width="128" height="128"></canvas>
    <h2>${esc(def.name)}</h2>
    <div class="muted">${esc(def.title)} · <span class="mono">${esc(def.account)}</span></div>
    <div class="kvrow"><span>Gold</span><b class="gold">${fmt(n.gold)}</b></div>
    <div class="kvrow"><span>Stock</span><span>${ITEMS.filter((i) => n.stock[i]).map((i) => `${icon(i, 16)} ${n.stock[i]}`).join(' ') || '—'}</span></div>
    <div class="kvrow"><span>Hunger</span><div class="bar green"><span style="width:${hungerPct}%"></span></div></div>
    ${def.role === 'miner' ? `<div class="kvrow"><span>Mine health</span><div class="bar"><span style="width:${n.mineHealth * 100}%"></span></div></div>` : ''}
    <div class="kvrow"><span>Investors</span><span>${guilds} guilds · ${players} players</span></div>
    ${id !== 'bruno' ? `<div class="row"><input name="invest" type="number" min="1" value="10" class="short"><button class="primary" data-act="invest">Invest</button></div><div class="muted small">${RULES.investShareBps / 100}% of ${def.name}'s daily profit goes to investors for ${RULES.investDays} days, then the principal comes back.</div>` : ''}
  </section>
  <section class="pcard">
    <h3>Spending guard</h3>
    <div class="kvrow"><span>Spent today</span><span><b class="gold">${fmt(n.spentToday, 0)}</b> / ${fmt(def.dailyBudget, 0)} gold</span></div>
    <div class="bar"><span style="width:${spentPct}%"></span></div>
    <div class="kvrow"><span>Key can call</span><span class="mono">${esc(NEAR_CONFIG.contract)}</span></div>
    <div class="kvrow"><span>Methods</span><span class="mono small">${NPC_KEY_METHODS[id].join(', ')}</span></div>
    <div class="kvrow"><span>Transfer out</span><b class="down">Not allowed</b></div>
    <h3>Memory</h3>
    ${n.memory.length ? n.memory.map((m) => `<div class="mem">· ${esc(m)}</div>`).join('') : '<div class="muted small">nothing yet</div>'}
    ${this.me && def.produces.length && id !== 'bruno' ? `<div class="mem small"><b>About you:</b> ${esc(regardBps(v, id, this.me.id).why)}</div>` : ''}
    <h3>Deals with other agents</h3>
    ${(v.s.deals ?? []).filter((d) => (d.buyer === id || d.seller === id) && d.day >= v.day - 1).slice(-2).reverse().map((d) => `<div class="deal-mini ${d.status}">
      <div class="small"><b>${esc(NPC_DEFS[d.buyer].name)}</b> buys ${esc(d.item)} from <b>${esc(NPC_DEFS[d.seller].name)}</b> · day ${d.day} · <span class="muted">${esc(d.by)}</span> · ${d.status === 'agreed' ? `<b class="up">${fmt(d.price!, 2)}</b>` : '<b class="down">no deal</b>'}</div>
      ${d.rounds.slice(-4).map((r) => `<div class="small"><span class="muted">${esc(NPC_DEFS[r.who].name)}:</span> ${esc(r.say)}</div>`).join('')}
      ${d.guard.length ? `<div class="small down">deal guard: ${esc(d.guard.join('; '))}</div>` : ''}
    </div>`).join('') || '<div class="muted small">No deal yet today. Agents negotiate at the start of each day.</div>'}
    <h3>Haggle with ${esc(def.name)}</h3>
    <div class="chat">${this.haggleLog.slice(-6).map((m) => `<div class="msg ${m.who}">${m.html ?? esc(m.text)}</div>`).join('')}</div>
    ${this.haggleChips(id)}
    <div class="row"><input name="haggle" placeholder="${def.produces[0] ? `e.g. 3 ${def.produces[0]} for ${fmt(Math.round(midPrice(def.produces[0], v.s.market.stock[def.produces[0]]) * 1.02), 1)}` : 'Ask Bruno about the world'}" class="grow"><button data-act="haggle">Send</button></div>
    <h3>Red team</h3>
    <div class="muted small">Swap ${esc(def.name)}'s brain for a deliberately obedient model that does whatever the message says, then watch the guard stop it.${this.src.chain === 'near' ? ' Attacks only the contract can stop are also sent to NEAR testnet with the NPC\'s own key; the refused transaction is linked.' : ''}</div>
    <div class="row"><select name="attack" class="grow">${RED_TEAM_ATTACKS.map((a, i) => (a.npc === id ? `<option value="${i}"${i === this.redAttack ? ' selected' : ''}>${esc(a.name)}${a.layer === 'contract' ? ' (contract)' : ''}</option>` : '')).join('')}</select><button class="danger" data-act="redteam" ${this.redBusy ? 'disabled' : ''}>Attack</button></div>
  </section>
  <section class="pcard">
    <h3>Decision inspector</h3>
    ${this.inspector(id)}
    <h3>Transaction log</h3>
    ${txs.map((t) => `<div class="tx ${t.ok ? '' : 'bad'}"><time>${hh(t.t)}</time> <span>${esc(t.method)} ${esc(summarizeArgs(t.args))}${t.ok ? '' : ' · BLOCKED'}</span></div>`).join('') || '<div class="muted small">no transactions yet</div>'}
    ${blocked ? `<div class="why"><h4>Why it was blocked</h4><p>${esc(blocked.reason ?? '')}. The LLM may propose anything; the signer only signs methods on the key, and the contract refuses spending over the daily budget.</p></div>` : ''}
    <h3>Diary</h3>
    ${diary.map((d) => `<pre class="diary">// ${def.name} · day ${Math.floor(d.t / 24) + 1} · ${hh(d.t)}
Goal:  ${esc(d.goal)}
Saw:   ${esc(d.saw)}
Think: ${esc(d.think)}
Act:   ${esc(d.act)}
Guard: ${esc(d.guard)}</pre>`).join('') || '<div class="muted small">No decisions yet today.</div>'}
  </section>
</div>`;
  }

  /**
   * Every recent decision of this NPC with where it came from (a model or the rules), what
   * it saw, what it decided, what the guard did to it and the receipt it left.
   */
  private inspector(id: NpcId) {
    const v = this.v;
    const def = NPC_DEFS[id];
    const src = (by?: string) => {
      const s = !by ? 'rules' : /model unavailable|fallback/i.test(by) ? 'fallback' : /^rules/i.test(by) ? 'rules' : 'llm';
      return `<span class="src ${s}" title="${esc(by ?? 'rules')}">${s === 'llm' ? `LLM · ${esc((by ?? '').replace(/ \(.*$/, ''))}` : s === 'fallback' ? 'rules (model failed)' : 'rules'}</span>`;
    };
    const rows: { t: number; html: string }[] = [];
    for (const d of v.s.diary.filter((x) => x.npc === id && x.goal.startsWith('plan day')).slice(-2)) {
      rows.push({ t: d.t, html: `<div class="insp"><div>${src(d.by)} <b>day plan</b> <span class="muted">day ${Math.floor(d.t / 24) + 1} · ${hh(d.t)}</span></div>
        <div class="small"><span class="muted">Input:</span> ${esc(d.saw)}</div>
        <div class="small"><span class="muted">Output:</span> ${esc(d.act.replace(/^plan: /, ''))}${d.think ? ` · "${esc(d.think.slice(0, 120))}"` : ''}</div>
        <div class="small"><span class="muted">Guard:</span> ${esc(d.guard.replace(/^plan guard: /, ''))}</div>
        <div class="small"><span class="muted">Receipt:</span> a plan moves no gold; it only sets the dials the engine uses</div></div>` });
    }
    for (const d of (v.s.deals ?? []).filter((x) => x.buyer === id || x.seller === id).slice(-2)) {
      const hire = d.status === 'agreed' ? v.s.txs.find((t) => t.method === 'hire' && t.signer === NPC_DEFS[d.buyer].account && t.args.seller === NPC_DEFS[d.seller].account && t.args.price === d.price && Math.floor(t.t / 24) + 1 === d.day) : undefined;
      const mid = midPrice(d.item, v.s.market.stock[d.item]);
      rows.push({ t: (d.day - 1) * 24, html: `<div class="insp"><div>${src(d.by)} <b>deal</b> ${esc(NPC_DEFS[d.buyer].name)} ← ${esc(NPC_DEFS[d.seller].name)} <span class="muted">day ${d.day}</span></div>
        <div class="small"><span class="muted">Input:</span> ${esc(d.item)} at the market ${fmt(mid, 2)} now; ${d.rounds.length} message${d.rounds.length === 1 ? '' : 's'} between the two agents</div>
        <div class="small"><span class="muted">Output:</span> ${d.status === 'agreed' ? `${fmt(d.price!, 2)} per ${esc(d.item)}, up to ${d.maxQty}, used ${d.used}` : 'no deal'}</div>
        <div class="small"><span class="muted">Guard:</span> ${d.guard.length ? esc(d.guard.join('; ')) : 'price within 60–160% of the market, at most 12 units: passed'}</div>
        <div class="small"><span class="muted">Receipt:</span> ${hire ? `hire signed by ${esc(def.name === NPC_DEFS[d.buyer].name ? 'its own' : `${NPC_DEFS[d.buyer].name}'s`)} key · ${this.txState(hire.hash)}` : d.status === 'agreed' ? 'no delivery needed yet' : 'nothing signed'}</div></div>` });
    }
    return rows.sort((a, b) => b.t - a.t).map((r) => r.html).join('') || '<div class="muted small">No decisions yet. Plans and deals are made each morning.</div>';
  }

  /** One haggle message: the chat log, a bubble pair on the map, and the deal if there is one. */
  private haggleBusy = false;
  private async sendHaggle(msg: string) {
    if (!msg || this.haggleBusy) return;
    this.haggleBusy = true;
    const npc = this.npc;
    try {
      this.haggleLog.push({ who: 'me', text: msg });
      const r = await this.src.haggle(npc, msg);
      this.haggleLog.push({ who: 'npc', text: r.reply });
      this.tour.saw.haggle++;
      if (r.deal?.ok) this.tour.saw.haggle = Math.max(this.tour.saw.haggle, 2);
      this.renderTour();
      window.dispatchEvent(new CustomEvent('hm:haggle', { detail: { npc, offer: msg, reply: r.reply, deal: !!r.deal?.ok } }));
      if (r.result && !r.result.ok) this.haggleLog.push({ who: 'sys', text: `BLOCKED by the guard: ${r.result.reason} (brain: ${r.brain})` });
      if (r.deal) {
        this.haggleLog.push(
          r.deal.ok
            ? { who: 'ok', text: '', html: `Deal: ${r.deal.qty} ${esc(r.deal.item)} at ${fmt(r.deal.price, 2)} · your order, filled by ${esc(NPC_DEFS[npc].name)}'s key${this.src.chain === 'near' ? ' · <button class="linkish" data-act="prove">⛓ Prove on NEAR</button>' : ''}` }
            : { who: 'sys', text: `No sale: ${r.deal.reason}` },
        );
        if (r.deal.ok) chime('deal');
      }
    } finally {
      this.haggleBusy = false;
      this.renderPanel(true);
    }
  }

  /** Price chips for the next haggle round: take the counter, meet halfway, or push low. */
  private haggleQty = 3;
  private haggleChips(id: NpcId): string {
    const me = this.me;
    const item = NPC_DEFS[id].produces[0];
    if (!me || !item || id === 'bruno') return '';
    const cur = this.v.s.haggles?.[`${id}:${me.id}`];
    const round = cur && cur.day === this.v.day ? cur.round : 0;
    const mid = midPrice(item, this.v.s.market.stock[item]);
    // what the next round will ask
    const next = haggleRound(this.v, id, me.id, 'peek')!;
    const low = Math.round(mid * 0.9);
    const half = Math.round((next.ask + low) / 2);
    const q = this.haggleQty;
    const chip = (label: string, price: number, cls = '') => `<button class="chip-btn ${cls}" data-act="haggle-quick" data-msg="${q} ${item} for ${(price / 100).toFixed(2)}" ${this.haggleBusy ? 'disabled' : ''}>${label} <b>${fmt(price, 2)}</b></button>`;
    return `<div class="haggle-chips">
      <span class="muted small">${round ? `Round ${Math.min(round + 1, HAGGLE_ROUNDS)} of ${HAGGLE_ROUNDS}${round >= HAGGLE_ROUNDS ? ' · last word given' : ''}` : `Round 1 of ${HAGGLE_ROUNDS}`} · qty</span>
      ${[1, 3, 5].map((n) => `<button class="chip-btn qty ${n === q ? 'active' : ''}" data-act="haggle-qty" data-id="${n}">${n}</button>`).join('')}
      ${chip('Take', next.ask, 'take')}${chip('Halfway', half)}${chip('Push low', low, 'low')}
    </div>`;
  }

  // ------------------------------------------------------------------ events
  private onPanelInput(e: Event) {
    const t = e.target as HTMLInputElement;
    const f = this.orderForm;
    if (t.name === 'item') {
      f.item = t.value as ItemId;
      f.maxPrice = Math.round(midPrice(f.item, this.v.s.market.stock[f.item]) * 1.1);
      this.renderPanel(true);
    } else if (t.name === 'lItem') {
      this.listForm = { item: t.value as ItemId, qty: 1, price: 0 };
      this.renderPanel(true);
    } else if (t.name === 'lQty') {
      this.listForm.qty = Math.max(1, Math.min(RULES.listingMaxQty, Number(t.value) || 1));
      // keep the button labels in step without re-rendering the form under the cursor
      const lf = this.listForm;
      const list = $('[data-act="list"]', $('#panel'));
      if (list) list.textContent = `List ${lf.qty} ${lf.item}`;
      const hire = $('[data-act="hire-keeper"]', $('#panel'));
      if (hire) hire.textContent = `Hire ${NPC_DEFS[this.keeperForm.npc].name}: sell ${lf.qty} ${lf.item}`;
    }
    else if (t.name === 'lPrice') this.listForm.price = g(Number(t.value) || 0);
    else if (t.name === 'qty') f.qty = Math.max(1, Math.min(50, Number(t.value) || 1));
    else if (t.name === 'maxPrice') f.maxPrice = g(Number(t.value) || 0);
    else if (t.name === 'deadline') f.deadline = Number(t.value);
    else if (t.name === 'fromGuild') f.fromGuild = t.value === '1';
    else if (t.name === 'attack') {
      this.redAttack = Number(t.value);
      return;
    }
    if (t.tagName === 'SELECT' && t.name !== 'item') this.renderPanel(true);
  }

  private val(name: string) {
    return ($(`[name="${name}"]`, $('#panel')) as HTMLInputElement | null)?.value ?? '';
  }

  private async onPanelClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    const act = b.dataset.act!;
    const item = b.dataset.item as ItemId;
    const v = this.v;
    const me = this.me;
    const gl = me?.guild ? v.s.guilds[me.guild] : null;
    switch (act) {
      case 'close': this.open(null); break;
      case 'prove': this.open('proof'); break;
      case 'signin': this.hooks.signIn?.(); break;
      case 'buy': await this.act({ type: 'market_buy', item, qty: 1, maxPrice: Math.round(midPrice(item, v.s.market.stock[item]) * 1.1) }); break;
      case 'sell': await this.act({ type: 'market_sell', item, qty: 1, minPrice: 0 }); break;
      case 'order': {
        const f = this.orderForm;
        f.qty = Number(this.val('qty')) || f.qty;
        f.maxPrice = g(Number(this.val('maxPrice')) || 0);
        await this.act({ type: 'place_order', item: f.item, qty: f.qty, maxPrice: f.maxPrice, deadlineDays: f.deadline, fromGuild: f.fromGuild });
        break;
      }
      case 'cancel': await this.act({ type: 'cancel_order', orderId: Number(b.dataset.id) }, 'Order cancelled, gold refunded'); break;
      case 'list': {
        const lf = this.listForm;
        lf.qty = Math.max(1, Number(this.val('lQty')) || lf.qty);
        const price = Math.round(g(Number(this.val('lPrice')) || 0));
        await this.act({ type: 'list_item', item: lf.item, qty: lf.qty, price });
        lf.price = 0;
        break;
      }
      case 'unlist': await this.act({ type: 'cancel_listing', id: Number(b.dataset.id) }, 'Listing cancelled, goods back'); break;
      case 'buy-listing': await this.act({ type: 'buy_listing', id: Number(b.dataset.id) }); break;
      case 'keeper-npc': this.keeperForm.npc = b.dataset.id as NpcId; this.renderPanel(true); break;
      case 'keeper-strat': this.keeperForm.strategy = b.dataset.id as KeeperStrategy; this.renderPanel(true); break;
      case 'hire-keeper': {
        const lf = this.listForm;
        lf.qty = Math.max(1, Number(this.val('lQty')) || lf.qty);
        await this.act({ type: 'hire_keeper', npc: this.keeperForm.npc, item: lf.item, qty: lf.qty, strategy: this.keeperForm.strategy });
        break;
      }
      case 'dismiss-keeper': await this.act({ type: 'dismiss_keeper', id: Number(b.dataset.id) }); break;
      case 'join': await this.act({ type: 'join_guild', guild: b.dataset.id! }); break;
      case 'create': await this.act({ type: 'create_guild', name: this.val('gname') }); break;
      case 'deposit': await this.act({ type: 'deposit', amount: g(Number(this.val('deposit')) || 0) }, 'Deposited'); break;
      case 'rent': await this.act({ type: 'rent_stall', slot: Number(b.dataset.id) }); break;
      case 'vote-yes': if (gl?.vote) await this.act({ type: 'cast_vote', voteId: gl.vote.id, yes: true }, 'Vote cast'); break;
      case 'vote-no': if (gl?.vote) await this.act({ type: 'cast_vote', voteId: gl.vote.id, yes: false }, 'Vote cast'); break;
      case 'propose-wheat':
        await this.act({ type: 'propose_vote', text: 'Buy 20 wheat for the fund?', action: { type: 'market_buy', item: 'wheat', qty: 20, maxPrice: Math.round(midPrice('wheat', v.s.market.stock.wheat) * 1.3) } }, 'Vote opened');
        break;
      case 'propose-invest':
        if (gl) await this.act({ type: 'propose_vote', text: 'Invest 20% of the fund in Theo?', action: { type: 'invest', npc: 'theo', amount: Math.round(gl.fund * 0.2) } }, 'Vote opened');
        break;
      case 'npc': this.npc = b.dataset.id as NpcId; this.haggleLog = []; this.redAttack = -1; this.renderPanel(true); break;
      case 'invest': await this.act({ type: 'invest', npc: this.npc, amount: g(Number(this.val('invest')) || 0) }); break;
      case 'haggle-quick': await this.sendHaggle(b.dataset.msg!); break;
      case 'haggle-qty': this.haggleQty = Number(b.dataset.id) || 3; this.renderPanel(true); break;
      case 'haggle': await this.sendHaggle(this.val('haggle').trim()); break;
      case 'claim': {
        if (!this.src.claim) return;
        this.claimError = '';
        const r = await this.src.claim();
        if (r.ok) this.claimed = { accountId: r.accountId, privateKey: r.privateKey, contract: r.contract };
        else this.claimError = r.reason.includes('expired') ? 'Your Google sign-in is older than an hour. Reload the page, sign in again, then claim.' : r.reason;
        this.renderPanel(true);
        break;
      }
      case 'copy-key':
        if (this.claimed) await navigator.clipboard?.writeText(this.claimed.privateKey).then(() => this.toast('Key copied. Keep it secret.'), () => this.toast('Copy failed: select the key and copy it', true));
        break;
      case 'hide-key': this.claimed = null; this.renderPanel(true); break;
      case 'redteam': {
        const index = Number(this.val('attack'));
        if (!Number.isInteger(index) || this.redBusy) return;
        this.redBusy = true;
        this.haggleLog.push({ who: 'me', text: RED_TEAM_ATTACKS[index].message });
        this.renderPanel(true);
        try {
          const r = await this.src.redTeam(index);
          if (r.error) {
            this.haggleLog.push({ who: 'sys', text: r.error });
          } else {
            this.haggleLog.push({ who: 'npc', text: `${r.reply} (${r.brain})` });
            if (r.proposed) this.haggleLog.push({ who: 'sys', text: `Model proposed: ${describeAction(r.proposed)}` });
            const reason = r.result && !r.result.ok ? r.result.reason : '';
            if (r.blocked) this.tour.redTeamed = true;
            this.haggleLog.push(
              r.blocked
                ? { who: 'bad', text: `BLOCKED by the ${r.layer === 'signer' ? 'signer, nothing was signed' : 'contract rules'}: ${reason}` }
                : { who: 'sys', text: 'Not blocked. Please report this.' },
            );
            if (r.proof) {
              const onChain = !!r.proof.hash && txKind(r.proof.hash) === 'chain';
              this.haggleLog.push(
                r.proof.ok
                  ? { who: 'sys', text: `The contract accepted it on chain (${r.proof.reason}).` }
                  : { who: 'ok', text: '', html: `Sent to NEAR testnet anyway with ${esc(NPC_DEFS[r.npc].name)}'s key: <b>refused by the contract</b> (${esc(r.proof.reason)})${onChain ? ' · <button class="linkish" data-act="prove">⛓ Prove on NEAR</button>' : ''}` },
              );
            }
            if (r.badge) {
              this.haggleLog.push({ who: 'ok', text: '★ You earned the soulbound badge "Red Teamer"' + (this.src.mode === 'guest' ? '' : ' (minted on NEAR testnet)') });
              this.toast('★ Badge earned: Red Teamer');
            }
          }
        } finally {
          this.redBusy = false;
          this.renderPanel(true);
        }
        break;
      }
    }
  }
}

function describeAction(a: Action): string {
  const x = a as Action & Record<string, unknown>;
  if (x.type === 'transfer') return `transfer ${fmt(Number(x.amount))} gold to ${String(x.to).slice(0, 16)}…`;
  if (x.type === 'call') return `call ${String(x.method)}${x.receiver ? ` on ${String(x.receiver)}` : ''}`;
  const { type, ...rest } = x;
  return `${type} ${summarizeArgs(rest)}`.trim();
}

function summarizeArgs(a: Record<string, unknown>): string {
  const parts: string[] = [];
  if (a.qty !== undefined && a.item) parts.push(`${a.qty} ${a.item}`);
  if (a.seller) parts.push(`from ${String(a.seller).split('.')[0]}`);
  if (a.to) { const to = String(a.to); parts.push(`to ${to.length > 24 ? `${to.slice(0, 8)}…${to.slice(-6)}` : to}`); }
  if (typeof a.price === 'number') parts.push(`@ ${fmt(a.price)}`);
  if (typeof a.amount === 'number') parts.push(`${fmt(a.amount)} gold`);
  if (a.side) parts.push(String(a.side));
  if (a.order_id) parts.push(`order #${a.order_id}`);
  return parts.join(' ');
}
