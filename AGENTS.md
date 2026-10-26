# Notes for coding agents (Cline, Claude Code, Codex)

- Game, UI, code, comments and docs are in **English**.
- One economy, three mirrors: rules live in `packages/economy` (engine + guard), `apps/server/src/chain/signer.ts` (signer) and `contracts/hearth` (contract). A rule change touches all three in one PR and keeps `npm test`, `npm run sim` and `npm run contract:test` green.
- Never commit: the Cute Fantasy assets (`apps/client/public/assets/cute_fantasy/`, license forbids redistribution), `.env`, keys, `submission.json`.
- Never push, force-push, make the repo public, deploy to mainnet, sign transactions or post anywhere without the human's explicit yes (see `docs/HACKATHON.md`).
- The LLM proposes, the signer and contract decide. Do not add a code path where model output reaches the chain without `checkNpcAction`.
- Gold is integer centigold everywhere. No floats for balances.
- Keep `README.md` as "do X → see Y" steps a judge can follow; update the Status table when something moves from planned to working.
- Before you finish a task: `npm run typecheck && npm test`; for contract changes also `npm run contract:test`; for economy changes `npm run sim` and check the Checks table in `docs/economy-sim.md`.
