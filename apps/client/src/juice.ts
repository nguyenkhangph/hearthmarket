/**
 * Trade feedback: a floating "+12 gold", a few coins flying to the purse and a short chime,
 * whenever the player's gold changes. Sounds are synthesised (no audio files) and can be muted;
 * everything respects prefers-reduced-motion.
 */
const MUTE_KEY = 'hm.mute';

let ctx: AudioContext | undefined;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* private window */
  }
}

/** A short coin chime (income), a soft tick (spending) or a low buzz (refused). */
export function chime(kind: 'gain' | 'spend' | 'deal' | 'bad') {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const notes = kind === 'gain' ? [988, 1319] : kind === 'deal' ? [784, 988, 1319] : kind === 'spend' ? [660] : [196, 165];
    const t0 = ctx.currentTime;
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = kind === 'bad' ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      const t = t0 + i * 0.07;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === 'bad' ? 0.05 : 0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'spend' ? 0.12 : 0.28));
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch {
    /* no audio */
  }
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** "+12.5 gold" rising from an element (the purse chip by default). */
export function floatText(anchor: Element | null, text: string, good: boolean) {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = `juice-float ${good ? 'good' : 'bad'}`;
  el.textContent = text;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.bottom + 4}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

/** A few coins fly from a point on screen to the purse. */
export function coinBurst(from: { x: number; y: number } | null, to: Element | null, n = 6) {
  if (!from || !to || reduced()) return;
  const r = to.getBoundingClientRect();
  const tx = r.left + 14, ty = r.top + r.height / 2;
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'juice-coin';
    c.style.left = `${from.x}px`;
    c.style.top = `${from.y}px`;
    document.body.appendChild(c);
    const dx = (Math.random() - 0.5) * 70, dy = -30 - Math.random() * 40;
    c.animate(
      [
        { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${tx - from.x}px), calc(-50% + ${ty - from.y}px)) scale(.5)`, opacity: 0.2 },
      ],
      { duration: 700 + i * 60, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' },
    ).onfinish = () => c.remove();
  }
  to.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 260, delay: 650 });
}

/** Last pointer position, so a trade's coins start where the player clicked. */
export const lastPointer: { x: number; y: number } | { x: null; y: null } = { x: null, y: null };
window.addEventListener('pointerdown', (e) => Object.assign(lastPointer, { x: e.clientX, y: e.clientY }), { capture: true, passive: true });
