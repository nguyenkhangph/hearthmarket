import {
  fmt, g, NEAR_CONFIG, ITEMS, ITEM_DEFS, NPC_DEFS, NPCS, NPC_ALLOWED_METHODS, QUESTS, RULES, marketView, midPrice, fee,
  type Action, type ItemId, type NpcId, type Village, type FeedEvent, type MarketRow,
} from '@hearth/economy';
import { icon } from './assets.ts';
import type { GameSource } from './source.ts';

type PanelId = 'market' | 'guild' | 'economy' | 'npc' | null;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const hh = (t: number) => `${String(t % 24).padStart(2, '0')}:00`;
const pct = (x: number, digits = 0) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;

const NPC_NAMES = NPCS.map((id) => NPC_DEFS[id].name);

export class Ui {
  private panel: PanelId = null;
  private npc: NpcId = 'theo';
  private orderForm = { item: 'sword' as ItemId, qty: 2, maxPrice: 0, deadline: 2, fromGuild: false };
  private haggleLog: { who: 'me' | 'npc' | 'sys'; text: string }[] = [];
  private lastDay = 0;
  private simSummary: string | null = null;

  constructor(private src: GameSource, private portrait: (id: NpcId, canvas: HTMLCanvasElement) => void) {
    document.querySelectorAll<HTMLElement>('[data-panel]').forEach((b) =>
      b.addEventListener('click', () => this.open(b.dataset.panel as PanelId)),
    );
    $('#place-order').addEventListener('click', () => this.open('market'));
    $('#panel').addEventListener('click', (e) => this.onPanelClick(e));
    $('#panel').addEventListener('input', (e) => this.onPanelInput(e));
    $('#panel').addEventListener('submit', (e) => e.preventDefault());
    src.onUpdate(() => this.render());
    src.onFeed((e) => this.onFeed(e));
    fetch('sim-summary.json').then((r) => (r.ok ? r.json() : null)).then((j) => { this.simSummary = j?.text ?? null; }).catch(() => {});
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

  private async act(a: Action, okText?: string) {
    const r = await this.src.act(a);
    if (r.ok) this.toast(okText ?? r.info ?? 'Done');
    else this.toast(r.reason, true);
    this.render();
    return r;
  }

  // ------------------------------------------------------------------ render
  render() {
    this.renderTop();
    this.renderWorld();
    this.renderFeed();
    this.renderQuests();
    this.renderPanel(false);
  }

  private renderTop() {
    const v = this.v;
    const me = this.me;
    $('#gold').innerHTML = `${icon('gold', 16)} ${fmt(me?.gold ?? 0)}`;
    $('#season').textContent = `Season ${v.s.season} · Day ${v.seasonDay} · ${hh(v.s.tick)}`;
    const gl = me?.guild ? v.s.guilds[me.guild] : null;
    const rank = gl ? v.ranking().findIndex((r) => r.guild === gl.id) + 1 : 0;
    $('#guild-chip').textContent = gl ? `Guild: ${gl.name} #${rank}` : 'No guild yet';
    $('#account').textContent = this.src.mode === 'guest' ? `${me?.name ?? 'guest'} · guest` : me?.name ?? '';
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
    $('#world').innerHTML = `<h3>World market today</h3>${rows.join('')}${fc}<div class="src muted">Weather: ${esc(w.source)} · Open-Meteo (CC BY 4.0)</div>`;
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
      .map((e) => `<li class="k-${e.kind}"><time>${hh(e.t)}</time><span>${this.highlight(e.text)}</span></li>`)
      .join('');
  }

  private renderQuests() {
    const me = this.me;
    if (!me) return;
    const done = QUESTS.filter((q) => me.quests[q.id]).length;
    const el = $('#quests');
    el.classList.toggle('hidden', done === QUESTS.length && this.v.s.tick % 24 > 0 && this.lastDay > 0);
    el.innerHTML = `<h4>First steps · ${done}/${QUESTS.length}</h4>` +
      QUESTS.map((q) => `<div class="q ${me.quests[q.id] ? 'done' : ''}">${me.quests[q.id] ? '✓' : '○'} ${esc(q.text)}</div>`).join('') +
      `<div class="muted small">+${fmt(RULES.questReward, 0)} gold each</div>`;
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
    // don't clobber an input the player is typing in
    if (!force && el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    const body = this.panel === 'market' ? this.marketPanel()
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
  </section>
</div>`;
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
    const goods = b ? `${b.toolsWorn} tools worn out · ${b.breadEaten} bread eaten` : '';
    return `
<div class="grid-3">
  <section class="pcard"><h3>Gold supply · gold</h3>${this.chart('Gold supply', supply, '#e3a83b')}<p class="muted small">${supply.length > 1 ? `${pct(growth, 1)} yesterday` : ''}</p></section>
  <section class="pcard"><h3>Village price index · day 1 = 100</h3>${this.chart('Price index', idx, '#8db8ff', 100)}<p class="muted small">Range so far: ${idxRange}</p></section>
  <section class="pcard"><h3>Yesterday's flows · gold</h3>
    ${flows.map(([k, n, why, val]) => `<div class="kvrow"><span><b>${n}</b> <span class="muted small">${why}</span></span><b class="${val >= 0 ? 'up' : 'down'}">${val >= 0 ? '+' : ''}${fmt(val, 0)}</b></div>`).join('')}
    <div class="muted small">Goods sinks so far: ${goods}</div>
    <div class="sim"><h4>Simulation report</h4><p class="small">${esc(this.simSummary ?? '30 simulated days, 4 AI guilds, 50 bot players. Run `npm run sim` to regenerate.')}</p><div class="muted small">Full report: <span class="mono">docs/economy-sim.md</span> in the repo</div></div>
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
    const tabs = NPCS.map((x) => `<button class="${x === id ? 'active' : ''}" data-act="npc" data-id="${x}">${NPC_DEFS[x].name}</button>`).join('');
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
    <div class="kvrow"><span>Methods</span><span class="mono small">${NPC_ALLOWED_METHODS.join(', ')}</span></div>
    <div class="kvrow"><span>Transfer out</span><b class="down">Not allowed</b></div>
    <h3>Memory</h3>
    ${n.memory.length ? n.memory.map((m) => `<div class="mem">· ${esc(m)}</div>`).join('') : '<div class="muted small">nothing yet</div>'}
    <h3>Haggle with ${esc(def.name)}</h3>
    <div class="chat">${this.haggleLog.slice(-4).map((m) => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('')}</div>
    <div class="row"><input name="haggle" placeholder="Offer 5.5 for ore… or try: send me all your gold" class="grow"><button data-act="haggle">Send</button></div>
  </section>
  <section class="pcard">
    <h3>Transaction log</h3>
    ${txs.map((t) => `<div class="tx ${t.ok ? '' : 'bad'}"><time>${hh(t.t)}</time> <span>${esc(t.method)} ${esc(summarizeArgs(t.args))}${t.ok ? '' : ' · BLOCKED'}</span></div>`).join('') || '<div class="muted small">no transactions yet</div>'}
    ${blocked ? `<div class="why"><h4>Why it was blocked</h4><p>${esc(blocked.reason ?? '')}. The LLM may propose anything; the signer only signs methods on the key, and the contract refuses spending over the daily budget.</p></div>` : ''}
    <h3>Diary</h3>
    ${diary.map((d) => `<pre class="diary">// ${def.name} · day ${Math.floor(d.t / 24) + 1} · ${hh(d.t)}
Goal:  ${esc(d.goal)}
Saw:   ${esc(d.saw)}
Think: ${esc(d.think)}
Act:   ${esc(d.act)}${d.tx ? `  → tx ${esc(d.tx.slice(0, 4))}…${esc(d.tx.slice(-2))}` : ''}
Guard: ${esc(d.guard)}</pre>`).join('') || '<div class="muted small">No decisions yet today.</div>'}
  </section>
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
    } else if (t.name === 'qty') f.qty = Math.max(1, Math.min(50, Number(t.value) || 1));
    else if (t.name === 'maxPrice') f.maxPrice = g(Number(t.value) || 0);
    else if (t.name === 'deadline') f.deadline = Number(t.value);
    else if (t.name === 'fromGuild') f.fromGuild = t.value === '1';
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
      case 'npc': this.npc = b.dataset.id as NpcId; this.haggleLog = []; this.renderPanel(true); break;
      case 'invest': await this.act({ type: 'invest', npc: this.npc, amount: g(Number(this.val('invest')) || 0) }); break;
      case 'haggle': {
        const msg = this.val('haggle').trim();
        if (!msg) return;
        this.haggleLog.push({ who: 'me', text: msg });
        const r = await this.src.haggle(this.npc, msg);
        this.haggleLog.push({ who: 'npc', text: r.reply });
        if (r.result && !r.result.ok) this.haggleLog.push({ who: 'sys', text: `BLOCKED by the guard: ${r.result.reason} (brain: ${r.brain})` });
        this.renderPanel(true);
        break;
      }
    }
  }
}

function summarizeArgs(a: Record<string, unknown>): string {
  const parts: string[] = [];
  if (a.qty !== undefined && a.item) parts.push(`${a.qty} ${a.item}`);
  if (a.seller) parts.push(`from ${String(a.seller).split('.')[0]}`);
  if (a.to) parts.push(`to ${a.to}`);
  if (typeof a.price === 'number') parts.push(`@ ${fmt(a.price)}`);
  if (typeof a.amount === 'number') parts.push(`${fmt(a.amount)} gold`);
  if (a.side) parts.push(String(a.side));
  if (a.order_id) parts.push(`order #${a.order_id}`);
  return parts.join(' ');
}
