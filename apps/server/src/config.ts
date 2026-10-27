import { NPCS, type NpcId } from '@hearth/economy';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  secondsPerGameHour: Number(env.SECONDS_PER_GAME_HOUR ?? 2.5),
  seed: Number(env.SEED ?? 42),
  worldSource: (env.WORLD_SOURCE ?? 'replay') as 'synthetic' | 'replay' | 'open-meteo',
  worldReplayFile: env.WORLD_REPLAY_FILE ?? 'data/world/replay-kansas-heatwave.json',

  brain: (env.NPC_BRAIN ?? 'off') as 'off' | 'llm',
  llm: {
    primary: { baseUrl: env.NEAR_AI_BASE_URL ?? '', apiKey: env.NEAR_AI_API_KEY ?? '', model: env.NEAR_AI_MODEL ?? '', name: 'NEAR AI Cloud' },
    fallback: { baseUrl: env.FALLBACK_LLM_BASE_URL ?? '', apiKey: env.FALLBACK_LLM_API_KEY ?? '', model: env.FALLBACK_LLM_MODEL ?? '', name: 'fallback' },
  },

  chain: (env.CHAIN ?? 'mock') as 'mock' | 'near',
  near: {
    network: env.NEAR_NETWORK ?? 'testnet',
    rpcUrl: env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com',
    contract: env.HEARTH_CONTRACT ?? 'hearth.testnet',
    npcKeys: Object.fromEntries(NPCS.map((id) => [id, env[`NPC_KEY_${id.toUpperCase()}`] ?? ''])) as Record<NpcId, string>,
    oracleAccount: env.ORACLE_ACCOUNT ?? '',
    oracleKey: env.ORACLE_KEY ?? '',
  },
};

export type Config = typeof config;
