import './style.css';
import type Phaser from 'phaser';
import { setContractAccount, type NpcId } from '@hearth/economy';
import { startGame } from './scene.ts';
import { LocalSource, RemoteSource, SignInError, type GameSource, type HelloAuth } from './source.ts';
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

interface ServerConfig {
  googleClientId: string;
  devLogin: boolean;
  contract: string;
  chain: 'mock' | 'near';
}

const loginMsg = (text: string, bad = false) => {
  const el = document.getElementById('login-msg')!;
  el.textContent = text;
  el.classList.toggle('bad', bad);
};

async function boot(name: string, auth: HelloAuth | null) {
  let src: GameSource;
  if (serverUrl && auth) {
    const remote = new RemoteSource(serverUrl, auth);
    try {
      await remote.ready;
      src = remote;
    } catch (e) {
      if (e instanceof SignInError) {
        loginMsg(`Sign-in refused: ${e.message}`, true);
        return;
      }
      alert(`Could not reach the game server at ${serverUrl}. Starting the offline village instead.`);
      src = new LocalSource(name);
    }
  } else {
    src = new LocalSource(name);
  }
  document.getElementById('login')!.classList.add('hidden');
  document.body.dataset.mode = src.mode;
  const ui = new Ui(src, portrait);
  game = startGame(document.getElementById('game')!, src, (id) => ui.open('npc', id));
  const speed = document.getElementById('speed') as HTMLSelectElement;
  speed.addEventListener('change', () => src.setSpeed(Number(speed.value)));
  (window as unknown as { hearth: unknown }).hearth = { src, ui };
}

/** Google Identity Services: the button returns a signed ID token that the server verifies. */
function loadGoogle(clientId: string) {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    const g = (window as unknown as { google?: GoogleGsi }).google;
    if (!g) return loginMsg('Google sign-in did not load.', true);
    g.accounts.id.initialize({
      client_id: clientId,
      callback: (r: { credential: string }) => {
        loginMsg('Signing in…');
        void boot('player', { kind: 'google', idToken: r.credential });
      },
    });
    g.accounts.id.renderButton(document.getElementById('google-btn')!, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
  };
  s.onerror = () => loginMsg('Could not load Google sign-in (blocked or offline).', true);
  document.head.appendChild(s);
}

interface GoogleGsi {
  accounts: {
    id: {
      initialize(o: { client_id: string; callback: (r: { credential: string }) => void }): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
    };
  };
}

async function setupLogin() {
  const emailForm = document.getElementById('email-form') as HTMLFormElement;
  let devLogin = true;
  let clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';
  if (serverUrl) {
    try {
      const cfg = (await (await fetch(`${serverUrl.replace(/^ws/, 'http')}/api/config`)).json()) as ServerConfig;
      clientId = cfg.googleClientId || clientId;
      devLogin = cfg.devLogin;
      if (cfg.contract) setContractAccount(cfg.contract);
      document.getElementById('online-note')!.textContent = cfg.chain === 'near'
        ? `Online village on NEAR testnet (${cfg.contract}). Your gold and badges sit under a NEAR account made for you; no wallet, no seed phrase.`
        : 'Online village (chain mirror off on this server).';
    } catch {
      loginMsg(`Game server ${serverUrl} is not answering. Guest mode still works.`, true);
    }
    if (clientId) loadGoogle(clientId);
    else document.getElementById('google-btn')!.classList.add('hidden');
  } else {
    document.getElementById('google-btn')!.classList.add('hidden');
  }
  emailForm.classList.toggle('hidden', !devLogin);
  (emailForm.querySelector('button') as HTMLButtonElement).textContent = serverUrl && clientId ? 'Continue with email (dev)' : 'Continue with email';
}

document.getElementById('guest')!.addEventListener('click', () => boot('guest', null));
document.getElementById('email-form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = (document.getElementById('email') as HTMLInputElement).value.trim();
  if (!email) return;
  void boot(email.split('@')[0], { kind: 'dev', email, name: email.split('@')[0] });
});
void setupLogin();
if (params.has('guest')) void boot('guest', null);
