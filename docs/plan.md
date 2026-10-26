# 14-day plan: 4 parallel tracks

Development window: 1–14 Nov 2026 (UTC). Repo public before 14 Nov 23:59 UTC. Submit once, after the human confirms the payload (see `docs/HACKATHON.md`).

Iron rule: no "if time allows" feature while a core feature still has a bug. Feature freeze on day 11; days 12–14 are fixes, polish, README and video only.

## Tracks and worktrees

Each track has its own git worktree and its own agent session (Cline or Claude Code). Tracks depend on each other only through `docs/interface.md`, frozen on day 1. Each evening, hand each agent one task with a clear done-check; review diffs and merge in the morning.

```sh
git worktree add ../hm-contract -b track/contract
git worktree add ../hm-server   -b track/server
git worktree add ../hm-client   -b track/client
git worktree add ../hm-economy  -b track/economy
```

| Day | Contract (`contracts/hearth`) | Server / agents (`apps/server`) | Client (`apps/client`) | Economy + data (`packages/economy`, `scripts`) |
| --- | --- | --- | --- | --- |
| 1 | Interface freeze; deploy skeleton to testnet | Schema, ws protocol | Social login spike | Normals from Historical API (`npm run normals`) |
| 2–5 | Market, orders, budget, fee | NPC brain on NEAR AI Cloud, haggling | Map, feed, market, orders | Sim report v1 |
| 6–7 | Guilds, stalls, season | Open-Meteo live, Bruno on chain | Guild, stalls, ranking | Tune sinks/faucets |
| 8–9 | NEP-141/245/171, deploy | 4 AI guilds on server | Health page, diary, quests | — |
| 10 | — | Signer hardening, injection suite in CI | Mobile layout | Market war (if time allows) |
| 11 | Security tests | Feature freeze | Feature freeze | Season pool (if time allows) |
| 12–13 | — | Live 24–48h run | Polish | README, video |
| 14 | — | — | — | Submit |

Milestones: **day 3** first NPC transaction on testnet · **day 5** core loop playable end to end · **day 8** guilds + stalls + 4 AI guilds running · **day 11** feature freeze · **day 13** stable live for 24h, video done.

## Task template for an overnight agent

```
Track: server. Goal: NPC brain calls NEAR AI Cloud for haggling.
Context: apps/server/src/brain/*.ts, docs/interface.md. Do not change packages/economy rules.
Done when: `npm test` passes, `NPC_BRAIN=llm npm run dev:server` answers a haggle in < 3 s,
and a haggle that proposes a transfer is still BLOCKED in the NPC panel.
```

## Before 1 Nov (design only, no repo history)

Ask NEAR Discord about pre-hackathon prep rules and multi-track submissions · try social login + function-call keys in a scratch folder · English game design doc · economy simulation · contract interface · Tiled map (optional, the procedural map works) · seasonal normals from the Historical API · mainnet NEAR account for the prize · confirm the Cute Fantasy license with Kenmi.
