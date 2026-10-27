import { NPCS, type NpcId } from '@hearth/economy';
import { NEAR_AI_DEFAULT_BASE_URL } from './brain/llm.ts';

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(env.PORT, 8787),
  secondsPerGameHour: num(env.SECONDS_PER_GAME_HOUR, 2.5),
  seed: num(env.SEED, 42),
  worldSource: (env.WORLD_SOURCE || 'replay') as 'synthetic' | 'replay' | 'open-meteo',
  worldReplayFile: env.WORLD_REPLAY_FILE || 'data/world/replay-kansas-heatwave.json',
  /** hours between Open-Meteo refreshes */
  worldRefreshHours: num(env.WORLD_REFRESH_HOURS, 3),

  brain: (env.NPC_BRAIN || 'off') as 'off' | 'llm',
  /** minutes between two day plans for the same NPC (token budget) */
  planEveryMinutes: num(env.NPC_PLAN_MINUTES, 5),
  llm: {
    primary: {
      baseUrl: env.NEAR_AI_BASE_URL || NEAR_AI_DEFAULT_BASE_URL,
      apiKey: env.NEAR_AI_API_KEY ?? '',
      model: env.NEAR_AI_MODEL ?? '',
      maxTokens: num(env.NEAR_AI_MAX_TOKENS, 600),
      name: 'NEAR AI Cloud',
    },
    fallback: { baseUrl: env.FALLBACK_LLM_BASE_URL ?? '', apiKey: env.FALLBACK_LLM_API_KEY ?? '', model: env.FALLBACK_LLM_MODEL ?? '', name: 'fallback' },
  },

  chain: (env.CHAIN || 'mock') as 'mock' | 'near',
  near: {
    network: env.NEAR_NETWORK || 'testnet',
    /** one or more endpoints, comma-separated; a rate-limited call moves on to the next */
    rpcUrl: env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs',
    contract: env.HEARTH_CONTRACT || 'hearth.testnet',
    npcKeys: Object.fromEntries(NPCS.map((id) => [id, env[`NPC_KEY_${id.toUpperCase()}`] ?? ''])) as Record<NpcId, string>,
    oracleAccount: env.ORACLE_ACCOUNT ?? '',
    oracleKey: env.ORACLE_KEY ?? '',
    /** real seconds between two on-chain day starts (reconcile + world post) */
    daySeconds: num(env.CHAIN_DAY_SECONDS, 50),
    maxTxPerMinute: num(env.CHAIN_MAX_TX_PER_MINUTE, 40),
  },

  auth: {
    /** Google OAuth client id (the same value the client uses as VITE_GOOGLE_CLIENT_ID) */
    googleClientId: env.GOOGLE_CLIENT_ID || env.VITE_GOOGLE_CLIENT_ID || '',
    /** typed-email login; on by default only while Google is not configured */
    devLogin: env.ALLOW_DEV_LOGIN ? env.ALLOW_DEV_LOGIN === '1' : !(env.GOOGLE_CLIENT_ID || env.VITE_GOOGLE_CLIENT_ID),
    /** secret for derived player accounts; keep it stable or players get new accounts */
    playerKeySecret: env.PLAYER_KEY_SECRET ?? '',
  },
};

export type Config = typeof config;
