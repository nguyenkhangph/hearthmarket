import './style.css';
import type Phaser from 'phaser';
import { setContractAccount, type NpcId } from '@hearth/economy';
import { startGame } from './scene.ts';
import { LocalSource, RemoteSource, type GameSource } from './source.ts';
import { Ui } from './ui.ts';

const params = new URLSearchParams(location.search);
const serverUrl = params.get('server') ?? (import.meta.env.VITE_SERVER_URL as string | undefined);
let game: Phaser.Game | null = null;
const contractEnv = import.meta.env.VITE_HEARTH_CONTRACT as string | undefined;
if (contractEnv) setContractAccount(contractEnv);

/** Draws the NPC's first idle frame, scaled up, for the profile card. */
function portrait(id: NpcId, canvas: HTMLCanvasElement) {
  if (!game) return;
  const tex = game.textures.get(`npc-${id}`);
  const frame = tex.get(0);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // the character occupies roughly the middle 32x32 of the 64x64 frame
  ctx.drawImage(frame.source.image as CanvasImageSource, frame.cutX + 16, frame.cutY + 8, 32, 40, 16, 4, 96, 120);
}

async function boot(name: string, email: string | null) {
  document.getElementById('login')!.classList.add('hidden');
  let src: GameSource;
  if (serverUrl) {
    const remote = new RemoteSource(serverUrl, (email ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), name);
    try {
      await remote.ready;
      src = remote;
    } catch {
      alert(`Could not reach the game server at ${serverUrl}. Starting the offline village instead.`);
      src = new LocalSource(name);
    }
  } else {
    src = new LocalSource(name);
  }
  document.body.dataset.mode = src.mode;
  const ui = new Ui(src, portrait);
  game = startGame(document.getElementById('game')!, src, (id) => ui.open('npc', id));
  const speed = document.getElementById('speed') as HTMLSelectElement;
  speed.addEventListener('change', () => src.setSpeed(Number(speed.value)));
  (window as unknown as { hearth: unknown }).hearth = { src, ui };
}

document.getElementById('guest')!.addEventListener('click', () => boot('guest', null));
document.getElementById('email-form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = (document.getElementById('email') as HTMLInputElement).value.trim();
  if (!email) return;
  boot(email.split('@')[0], email);
});
if (params.has('guest')) boot('guest', null);
