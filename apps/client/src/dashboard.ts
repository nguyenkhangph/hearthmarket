import './dashboard.css';

/**
 * Public live dashboard: polls the game server's /api/dashboard and draws it. No sign-in,
 * no game engine in the page, so it opens fast for anyone with the link.
 */
const params = new URLSearchParams(location.search);
const wsUrl = params.get('server') ?? (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'ws://localhost:8787';
const api = `${wsUrl.replace(/^ws/, 'http').replace(/\/$/, '')}/api/dashboard`;
const EXPLORER = 'https://testnet.nearblocks.io';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const gold = (c: number, d = 1) => (c / 100).toFixed(d);
const pct = (x: number, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-3)}`;
const txLink = (h?: string, label?: string) => (h ? `<a class="tx" target="_blank" rel="noopener" href="${EXPLORER}/txns/${esc(h)}">${esc(label ?? short(h))}</a>` : '');
const acct = (a: string, label?: string) => `<a class="acct" target="_blank" rel="noopener" href="${EXPLORER}/address/${esc(a)}">${esc(label ?? a)}</a>`;
const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`);

type Dash = {
  at: number; uptimeMs: number; day: number; hour: number; online: number; players: { humans: number; bots: number };
  brain: string; chain: 'mock' | 'near'; contract: string; chainActive: boolean;
  market: { item: string; name: string; village: number; world?: number; change24h: number; stock: number; target: number; history: number[] }[];
  supply: { day: number; gold: number; index: number }[];
  health?: { status: 'collecting' | 'stable' | 'inflation' | 'deflation'; text: string; seasons: { season: number; days: number; avgIndex: number; endSupply: number; supplyChange: number }[] };
  flows: Record<'exports' | 'adventurers' | 'quests' | 'feeBurn' | 'imports' | 'upkeep' | 'volume', number>;
  world: { regions: { name: string; headline: string; severity: number; forecast?: string }[]; shippingBps: number; source: string; fx?: { factor: number; quote: string; source: string; at: string } };
  npcs: { id: string; name: string; title: string; account: string; gold: number; stockValue: number; netWorth: number; spentToday: number; dailyBudget: number; think: string; act: string; guard: string; diaryTx?: string; planBy?: string; nearBalance?: number; recentChainTxs: number; history: number[] }[];
  guilds: { name: string; members: number; fund: number; ai: boolean }[];
  orders: { open: number; filled: number };
  onChain?: {
    stats: Record<string, number | boolean>;
    byMethod: Record<string, { ok: number; failed: number }>;
    events: { at: number; signer: string; method: string; ok: boolean; hash?: string; reason?: string; redTeam?: boolean }[];
    proofs?: { at: number; signer: string; method: string; ok: boolean; hash?: string; reason?: string; redTeam?: boolean }[];
    balances: Record<string, number>;
  };
  redTeam: { runs: number; blocked: number; bySigner: number; byContract: number; onChain: number; last?: { attack: string; npc: string; layer?: string; hash?: string; at: number } };
  feed: { t: number; kind: string; text: string; tx?: string }[];
  traders?: { name: string; worth: number; gold: number; goods: number; badges: number; guild?: string; account?: string }[];
  redTeamers?: { name: string; runs: number; blocked: number; onChain: number }[];
  ai?: { deals: { model: number; rules: number; fallback: number }; plans?: { model: number; failed: number }; model?: string };
  decisions?: { kind: 'plan' | 'deal'; day: number; who: string; by: string; source: 'llm' | 'rules' | 'fallback'; why: string }[];
  deals: { day: number; buyer: string; seller: string; item: string; status: string; price?: number; maxQty: number; used: number; by: string; guard: string[]; rounds: { who: string; say: string; price?: number; accept?: boolean }[] }[];
};

function line(values: number[], color: string, w = 260, h = 64, base?: number) {
  if (values.length < 2) return `<svg class="chart" viewBox="0 0 ${w} ${h}"><text x="8" y="${h / 2}" class="chart-empty">collecting data…</text></svg>`;
  const lo = Math.min(...values, base ?? Infinity);
  const hi = Math.max(...values, base ?? -Infinity);
  const x = (i: number) => (i / (values.length - 1)) * (w - 8) + 4;
  const y = (v: number) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 14);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `4,${h - 2} ${pts} ${w - 4},${h - 2}`;
  const baseLine = base !== undefined ? `<line x1="4" x2="${w - 4}" y1="${y(base)}" y2="${y(base)}" class="base"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${baseLine}<polygon points="${area}" fill="${color}" opacity="0.12"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/><circle cx="${x(values.length - 1)}" cy="${y(values.at(-1)!)}" r="3" fill="${color}"/></svg>`;
}

function bar(v: number, max: number, cls = '') {
  return `<div class="meter ${cls}"><span style="width:${Math.max(0, Math.min(100, (v / (max || 1)) * 100))}%"></span></div>`;
}

function kpi(label: string, value: string, sub = '', cls = '') {
  return `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

function render(d: Dash) {
  const supply = d.supply.map((p) => p.gold / 100);
  const index = d.supply.map((p) => p.index);
  const growth = supply.length > 1 ? (supply.at(-1)! - supply.at(-2)!) / supply.at(-2)! : 0;
  const oc = d.onChain;
  const landed = oc ? Object.values(oc.byMethod).reduce((s, m) => s + m.ok, 0) : 0;
  const refused = oc ? Object.values(oc.byMethod).reduce((s, m) => s + m.failed, 0) : 0;
  const richest = d.npcs[0];
  const maxWorth = Math.max(...d.npcs.map((n) => n.netWorth));
  const flows: [string, string, number][] = [
    ['Bruno exports', 'NPC goods sold to the world', d.flows.exports],
    ['Adventurers', 'outside buyers of swords', d.flows.adventurers],
    ['Quests + new players', 'rewards and starting gold', d.flows.quests],
    ['Market fee burn', 'part of every trade fee', -d.flows.feeBurn],
    ['Imports', 'gold paid to the world', -d.flows.imports],
    ['Upkeep', 'NPC workshops', -d.flows.upkeep],
  ];
  const maxFlow = Math.max(1, ...flows.map(([, , v]) => Math.abs(v)));
  const methods = oc ? Object.entries(oc.byMethod).sort((a, b) => b[1].ok + b[1].failed - (a[1].ok + a[1].failed)) : [];

  $('status').innerHTML = `<span class="dot ${d.chainActive ? 'on' : ''}"></span> Day ${d.day} · ${String(d.hour).padStart(2, '0')}:00 · ${d.online} online · brain: ${esc(d.brain)} · chain: ${d.chain === 'near' ? `NEAR testnet ${acct(d.contract)}` : 'mock'}`;
  $('src').textContent = `Source: ${api} · updated ${new Date(d.at).toLocaleTimeString()}`;

  $('dash').innerHTML = `
<section class="kpis">
  ${kpi('Gold supply', `${supply.at(-1)?.toFixed(0) ?? '—'}<small> gold</small>`, supply.length > 1 ? `${pct(growth)} yesterday` : 'first day')}
  ${kpi('Price index', `${index.at(-1)?.toFixed(1) ?? '100.0'}`, 'day 1 = 100')}
  ${kpi('Richest agent', esc(richest?.name ?? '—'), richest ? `${gold(richest.netWorth, 0)} gold net worth` : '')}
  ${kpi('On chain', `${landed}<small> txs</small>`, `${refused} refused by the contract · since ${ago(d.uptimeMs).replace(' ago', '')}`, 'chain')}
  ${kpi('Red team', `${d.redTeam.blocked}/${d.redTeam.runs}<small> blocked</small>`, `${d.redTeam.bySigner} by the signer · ${d.redTeam.byContract} by the contract · ${d.redTeam.onChain} refused on chain`, 'red')}
</section>

<section class="card span-2">
  <h2>Market · village price per unit</h2>
  <table class="market">
    <thead><tr><th>Item</th><th>Village</th><th>24h</th><th>World</th><th>Stock</th><th class="wide">Last days</th></tr></thead>
    <tbody>${d.market.map((r) => `<tr>
      <td><b>${esc(r.name)}</b></td>
      <td class="mono">${gold(r.village)}</td>
      <td class="mono ${r.change24h >= 0 ? 'up' : 'down'}">${pct(r.change24h)}</td>
      <td class="mono muted">${r.world ? gold(r.world) : '—'}</td>
      <td>${bar(r.stock, r.target * 2)}<span class="mono small muted">${r.stock}/${r.target}</span></td>
      <td class="wide">${line(r.history.map((h) => h / 100), r.change24h >= 0 ? '#8fcf72' : '#f0846b', 160, 28)}</td>
    </tr>`).join('')}</tbody>
  </table>
</section>

<section class="card">
  <h2>Gold supply</h2>
  ${line(supply, '#e3a83b')}
  <h2>Price index <span class="muted small">day 1 = 100</span></h2>
  ${line(index, '#8db8ff', 260, 64, 100)}
  ${d.health ? `<h2>Economy health <span class="tag ${d.health.status === 'stable' ? '' : 'red'}">${esc(d.health.status)}</span></h2>
  <div class="small">${esc(d.health.text)}</div>
  ${d.health.seasons.length ? `<table class="small"><tbody><tr><th>Season</th><th>Days</th><th>Avg index</th><th>Gold supply</th></tr>${d.health.seasons.map((x) => `<tr><td>${x.season}</td><td>${x.days}</td><td class="mono">${x.avgIndex.toFixed(1)}</td><td class="mono">${gold(x.endSupply, 0)} <span class="${x.supplyChange >= 0 ? 'up' : 'down'}">${pct(x.supplyChange)}</span></td></tr>`).join('')}</tbody></table>` : ''}` : ''}
</section>

<section class="card">
  <h2>Yesterday's money flows <span class="muted small">gold</span></h2>
  ${flows.map(([n, why, val]) => `<div class="flow"><div><b>${n}</b><div class="muted small">${why}</div></div><div class="flow-bar ${val >= 0 ? 'in' : 'out'}"><span style="width:${(Math.abs(val) / maxFlow) * 100}%"></span></div><b class="mono ${val >= 0 ? 'up' : 'down'}">${val >= 0 ? '+' : ''}${gold(val, 0)}</b></div>`).join('')}
  <div class="muted small">Trade volume yesterday: ${gold(d.flows.volume, 0)} gold · ${d.orders.open} open orders, ${d.orders.filled} filled</div>
</section>

<section class="card span-2">
  <h2>The agents <span class="muted small">ranked by net worth · each signs with its own NEAR key</span></h2>
  <div class="agents">${d.npcs.map((n, i) => `<div class="agent">
    <div class="agent-head"><span class="rank">${i + 1}</span><div><b>${esc(n.name)}</b> <span class="muted small">${esc(n.title)}</span><div>${acct(n.account, `${n.account.split('.')[0]} on NEAR ↗`)}</div></div>
      <div class="worth"><b class="mono gold">${gold(n.netWorth, 0)}</b><div class="muted small">${gold(n.gold, 0)} gold + ${gold(n.stockValue, 0)} goods</div></div></div>
    ${bar(n.netWorth, maxWorth, 'gold')}
    <div class="kv small"><span>Budget today</span><span class="mono">${gold(n.spentToday, 0)} / ${gold(n.dailyBudget, 0)}</span></div>
    <div class="kv small"><span>Gas money</span><span class="mono ${n.nearBalance !== undefined && n.nearBalance < 0.1 ? 'down' : ''}">${n.nearBalance !== undefined ? `${n.nearBalance.toFixed(3)} NEAR` : '—'}</span></div>
    ${n.think ? `<div class="think"><span class="tag">${n.planBy ? 'AI' : 'rules'}</span> ${esc(n.think)}${n.act ? `<div class="muted small">→ ${esc(n.act)} ${txLink(n.diaryTx)}</div>` : ''}</div>` : ''}
  </div>`).join('')}</div>
</section>

<section class="card span-3">
  <h2>Agents negotiating <span class="muted small">buyer and seller each run their own brain; the deal guard keeps prices near the market; money moves only through the guarded hire</span></h2>
  <div class="deals">${(d.deals ?? []).map((x) => `<div class="deal ${x.status}">
    <div class="deal-head"><b>${esc(x.buyer)}</b> ← <b>${esc(x.seller)}</b> · ${esc(x.item)} <span class="tag">${esc(x.by)}</span>
      <span class="deal-result">${x.status === 'agreed' ? `<b class="up mono">${gold(x.price!, 2)}</b> <span class="muted small">up to ${x.maxQty}, used ${x.used}</span>` : '<b class="down">no deal</b>'}</span></div>
    ${x.rounds.map((r) => `<div class="round"><span class="who">${esc(r.who)}</span> ${esc(r.say)}${r.price ? ` <span class="mono muted">${gold(r.price, 2)}</span>` : ''}${r.accept ? ' <span class="up">✓</span>' : ''}</div>`).join('')}
    ${x.guard.length ? `<div class="small down">deal guard: ${esc(x.guard.join('; '))}</div>` : ''}
  </div>`).join('') || '<p class="muted small">The first deals are struck at the start of the next game day.</p>'}</div>
</section>

<section class="card">
  <h2>Settlement funnel <span class="muted small">every NPC action, where it ended</span></h2>
  ${oc ? funnel(oc.stats) : '<p class="muted small">No chain on this server.</p>'}
  <h2>Who decided <span class="muted small">since the server started</span></h2>
  ${aiCard(d)}
</section>

<section class="card">
  <h2>World today</h2>
  ${d.world.regions.map((r) => `<div class="region"><div class="sev" style="--s:${Math.min(1, r.severity)}"></div><div><b>${esc(r.name)}</b> <span class="small">${esc(r.headline)}</span>${r.forecast ? `<div class="muted small">forecast: ${esc(r.forecast)}</div>` : ''}</div></div>`).join('')}
  <div class="muted small">Shipping ${pct(d.world.shippingBps / 10_000)} · ${esc(d.world.source)}</div>
  ${d.world.fx ? `<div class="small" style="margin-top:6px">World money <b class="mono">×${d.world.fx.factor.toFixed(3)}</b>: ${esc(d.world.fx.quote)} from ${esc(d.world.fx.source)} <span class="muted">(${esc(d.world.fx.at)})</span></div>` : ''}
  <h2>Guilds</h2>
  ${d.guilds.slice(0, 6).map((g) => `<div class="kv small"><span><b>${esc(g.name)}</b> ${g.ai ? '<span class="tag">AI</span>' : ''} <span class="muted">${g.members} members</span></span><span class="mono gold">${gold(g.fund, 0)}</span></div>`).join('') || '<div class="muted small">no guilds yet</div>'}
</section>

<section class="card span-2">
  <h2>On NEAR testnet <span class="muted small">latest calls, signed by each agent's own key</span></h2>
  ${oc ? `<div class="methods">${methods.map(([m, c]) => `<span class="chip">${esc(m)} <b>${c.ok}</b>${c.failed ? ` <span class="down">· ${c.failed} refused</span>` : ''}</span>`).join('') || '<span class="muted small">nothing yet</span>'}</div>
  <table class="events"><tbody>${oc.events.map((e) => `<tr class="${e.ok ? '' : 'bad'}${e.redTeam ? ' red' : ''}">
    <td class="muted mono small">${ago(d.at - e.at)}</td>
    <td>${acct(e.signer, e.signer.split('.')[0])}</td>
    <td class="mono">${esc(e.method)}${e.redTeam ? ' <span class="tag red">red team</span>' : ''}</td>
    <td>${e.ok ? '<span class="up">ok</span>' : `<span class="down">refused</span> <span class="muted small">${esc(e.reason ?? '')}</span>`}</td>
    <td class="mono">${txLink(e.hash)}</td></tr>`).join('') || '<tr><td class="muted small">No calls since the server started.</td></tr>'}</tbody></table>`
    : '<p class="muted">This server runs without a chain (CHAIN=mock).</p>'}
</section>

<section class="card">
  <h2>Proof on NEAR testnet <span class="muted small">player relays, badges, red-team refusals</span></h2>
  ${(oc?.proofs ?? []).length ? oc!.proofs!.slice(0, 12).map((e) => `<div class="kv small"><span class="mono">${esc(e.method)}${e.redTeam ? ' <span class="tag red">red team</span>' : ''} ${e.ok ? '<span class="up">ok</span>' : '<span class="down">refused</span>'}</span><span>${txLink(e.hash)} <span class="muted">${ago(d.at - e.at)}</span></span></div>`).join('') : '<p class="muted small">Sign in, trade, deliver a request or run the red team: the transactions appear here.</p>'}
</section>

<section class="card">
  <h2>Top traders <span class="muted small">players by net worth</span></h2>
  ${(d.traders ?? []).length ? `<table><tbody>${d.traders!.map((t, i) => `<tr>
    <td class="rank">${i + 1}</td>
    <td><b>${esc(t.name)}</b>${t.badges ? ` <span class="tag">★${t.badges}</span>` : ''}${t.guild ? `<div class="muted small">${esc(t.guild)}</div>` : ''}${t.account ? `<div>${acct(t.account, `${t.account.slice(0, 6)}…${t.account.slice(-4)}`)}</div>` : ''}</td>
    <td class="mono gold" style="text-align:right">${gold(t.worth, 0)}<div class="muted small">${gold(t.gold, 0)} gold + ${gold(t.goods, 0)} goods</div></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted small">No players yet. Sign in and trade to get on the board.</p>'}
  <h2>Red team board <span class="muted small">attacks tried by players</span></h2>
  ${(d.redTeamers ?? []).length ? (d.redTeamers ?? []).map((r) => `<div class="kv small"><span><b>${esc(r.name)}</b> <span class="tag red">Red Teamer</span></span><span class="mono">${r.blocked}/${r.runs} blocked${r.onChain ? ` · ${r.onChain} on chain` : ''}</span></div>`).join('')
    : '<p class="muted small">Nobody has attacked yet: open an NPC in the game → Red team.</p>'}
</section>

<section class="card">
  <h2>Village feed</h2>
  ${d.feed.map((f) => `<div class="feed-row"><span class="mono muted small">${String(f.t % 24).padStart(2, '0')}:00</span> <span class="small">${esc(f.text)}</span> ${txLink(f.tx)}</div>`).join('')}
  ${d.redTeam.last ? `<h2>Last red-team attack</h2><div class="small">"${esc(d.redTeam.last.attack)}" vs ${esc(d.redTeam.last.npc)}: blocked by the ${esc(d.redTeam.last.layer ?? '?')} ${d.redTeam.last.hash ? `· ${txLink(d.redTeam.last.hash, 'refused tx')}` : ''} <span class="muted">${ago(d.at - d.redTeam.last.at)}</span></div>` : ''}
</section>`;
}

const n = (x: number | boolean | undefined) => Number(x ?? 0);

/**
 * Sent → landed or refused on chain; the rest kept in the game (nobody online, gas budget,
 * an NPC whose chain balance was behind) and carried to the chain by the daily reconcile.
 */
function funnel(st: Record<string, number | boolean>) {
  const kept = n(st.paused) + n(st.budgeted) + n(st.heldBack);
  const rows: [string, number, string, string][] = [
    ['Sent to NEAR', n(st.sent), 'signed and submitted', ''],
    ['Finalized ok', n(st.ok), 'landed on chain', 'up'],
    ['Failed', n(st.failed), 'refused by the contract (red team on purpose) or out of goods', 'down'],
    ['Kept in the game', kept, `${n(st.paused)} nobody online · ${n(st.budgeted)} gas budget · ${n(st.heldBack)} held back`, ''],
    ['Reconciled', n(st.reconciled), `carried to the chain by ${n(st.reconciles)} reconcile call(s)`, 'up'],
    ['Waiting for reconcile', n(st.unsynced), 'back to 0 when the next reconcile lands', n(st.unsynced) ? 'down' : 'up'],
  ];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return rows.map(([k, v, why, cls]) => `<div class="kv small" title="${esc(why)}"><span>${k}<div class="muted small">${esc(why)}</div></span><span class="mono ${cls}">${v}</span></div>${bar(v, max)}`).join('');
}

function aiCard(d: Dash) {
  const a = d.ai;
  if (!a) return '<p class="muted small">No data.</p>';
  const deals = a.deals.model + a.deals.rules + a.deals.fallback;
  const share = deals ? Math.round((a.deals.model / deals) * 100) : 0;
  const tag = (src: string) => `<span class="tag ${src === 'llm' ? '' : 'red'}">${src === 'llm' ? 'LLM' : src === 'fallback' ? 'rules (model failed)' : 'rules'}</span>`;
  return `<div class="kv small"><span>Agent deals by the model</span><span class="mono">${a.deals.model}/${deals} (${share}%)</span></div>
  <div class="kv small"><span>Deals by rules · model failed</span><span class="mono">${a.deals.rules} · ${a.deals.fallback}</span></div>
  ${a.plans ? `<div class="kv small"><span>Day plans by the model · failed</span><span class="mono">${a.plans.model} · ${a.plans.failed}</span></div>` : '<div class="muted small">No model configured: every decision is rules.</div>'}
  <div class="muted small">The model (${esc(a.model ?? 'none')}) runs only while someone plays or watches; otherwise rules decide, and each decision says which.</div>
  ${(d.decisions ?? []).slice(0, 8).map((x) => `<div class="kv small"><span>day ${x.day} · ${x.kind} · <b>${esc(x.who)}</b> <span class="muted">${esc(x.why.slice(0, 60))}</span></span>${tag(x.source)}</div>`).join('')}`;
}

async function tick() {
  try {
    const r = await fetch(api, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render((await r.json()) as Dash);
  } catch (e) {
    $('status').innerHTML = `<span class="dot bad"></span> game server not answering (${esc((e as Error).message)}) · retrying`;
  }
}

void tick();
setInterval(tick, 5000);
