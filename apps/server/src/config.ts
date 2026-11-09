import { NPCS, type NpcId } from '@hearth/economy';
import { NEAR_AI_DEFAULT_BASE_URL } from './brain/llm.ts';

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(env.PORT, 8787),
  secondsPerGameHour: num(env.SECONDS_PER_GAME_HOUR, 5),
  seed: num(env.SEED, 42),
  worldSource: (env.WORLD_SOURCE || 'replay') as 'synthetic' | 'replay' | 'open-meteo',
  worldReplayFile: env.WORLD_REPLAY_FILE || 'data/world/replay-kansas-heatwave.json',
  /** hours between Open-Meteo refreshes */
  worldRefreshHours: num(env.WORLD_REFRESH_HOURS, 3),
  /** world money: 'near-intents' converts world prices at the XAUT price quoted by NEAR Intents; 'off' keeps them as is */
  worldFx: (env.WORLD_FX || 'near-intents') as 'near-intents' | 'off',
  worldFxMinutes: num(env.WORLD_FX_MINUTES, 30),

  brain: (env.NPC_BRAIN || 'off') as 'off' | 'llm',
  /** minutes between two day plans for the same NPC (token budget) */
  planEveryMinutes: num(env.NPC_PLAN_MINUTES, 5),
  /** minutes between two LLM negotiations of the same buyer/seller pair (rules negotiate daily) */
  dealEveryMinutes: num(env.NPC_DEAL_MINUTES, 4),
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
    contract: env.HEARTH_CONTRACT || 'hearthmarket.testnet',
    npcKeys: Object.fromEntries(NPCS.map((id) => [id, env[`NPC_KEY_${id.toUpperCase()}`] ?? ''])) as Record<NpcId, string>,
    oracleAccount: env.ORACLE_ACCOUNT ?? '',
    oracleKey: env.ORACLE_KEY ?? '',
    /** real seconds between two on-chain day starts (reconcile + world post) */
    daySeconds: num(env.CHAIN_DAY_SECONDS, 600),
    maxTxPerMinute: num(env.CHAIN_MAX_TX_PER_MINUTE, 20),
    /** gas budget: on-chain calls per NPC per real hour (0 = no cap); order fills and player relays are never capped */
    npcTxPerHour: num(env.CHAIN_NPC_TX_PER_HOUR, 20),
    /** one `produce` per NPC and item per game day instead of one per production tick */
    batchProduce: env.CHAIN_BATCH_PRODUCE !== '0',
    /**
     * stop mirroring NPC actions this many seconds after the last player leaves (0 = never pause).
     * Default 0: the chain keeps up with the game while judges look at it. Set 120 to save gas.
     */
    idleSeconds: num(env.CHAIN_IDLE_SECONDS, 0),
    /** an NPC with less spendable NEAR than this keeps its actions in the game (reconciled later) */
    minNpcNear: num(env.CHAIN_MIN_NPC_NEAR, 0.15),
    /** log a warning when a signing account has less than this much spendable NEAR */
    lowBalanceNear: num(env.CHAIN_LOW_BALANCE_NEAR, 0.1),
    /**
     * stall board on chain: player listings escrowed by the stalls contract (needs contract v6
     * and `set_stalls`). Off by default: listings stay in the game until the stalls contract is tested.
     */
    stallsOnChain: env.STALLS_ONCHAIN === '1',
    /** red-team attacks sent to the contract on chain (failed txs as proof), per hour, all players */
    redTeamProofsPerHour: num(env.CHAIN_REDTEAM_PROOFS_PER_HOUR, 12),
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
