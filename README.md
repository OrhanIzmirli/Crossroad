# Crossroad

*Formerly Agent Pay.* Where agents meet payments.

Parametric insurance that settles itself: three independent data sources decide the payout, and the money moves on Solana the moment the rule is hit — no adjuster, no claim form, no waiting.

Built at Blockchain Hack Warsaw (Colosseum hackathon).

## The problem

Traditional parametric insurance still relies on a single data feed and a manual claims process: a loss report, an adjuster visit, a paper trail. The policyholder waits — often a full season for a crop, or weeks for a delayed flight — for a payout that a simple formula could have already resolved.

## The solution

Crossroad reads three independent weather models for every policy (plus a satellite crop-health index where relevant) and applies a deterministic formula to decide how much is owed. The middle reading sets the payout, which is paid at once: no adjuster, no approval, no waiting. An AI writes a plain explanation of every payout, but it never sets or moves an amount.

Every payout is a real transaction on Solana devnet, verifiable on [Solana Explorer](https://explorer.solana.com/address/C5YQewQjTdvTzxf2mLdDYsfe2FyPjRVynCQfp4RBXA8T?cluster=devnet).

## Products

| Product | Covers | Trigger source(s) | Data |
|---|---|---|---|
| **Crop – Drought** | Rainfall falling below a threshold during the growing window | Three independent rainfall models, optional satellite NDVI | Live |
| **Crop – Excess rain** | Rainfall exceeding a threshold (flooding) | Three independent rainfall models, optional satellite NDVI | Live |
| **Event cancellation** | An outdoor event disrupted by weather | Three independent rainfall models, plus ticketing status as an extra opinion | Live |
| **Travel delay** | A flight or journey delayed past a threshold | Three independent delay feeds | Simulated (demo) |

Each product ships with a sensible default rule (trigger/exit values) that can be adjusted, or replaced entirely with a custom rule.

## How a payout is decided

```
payout_ratio = clamp((trigger - observed) / (trigger - exit), 0, 1)
```

- Every source's reading is turned into a payout ratio with the policy's own rule.
- The payout is the **median** of those ratios (the middle reading), paid in full on-chain at once. With three weather models, one broken or manipulated source is outvoted and cannot change the payout on its own.
- Nothing is held back and nobody has to approve anything. An AI writes a plain explanation of every payout and flags suspicious disagreements for a later audit; it never sets, changes or stops a payment.
- Known limit: if two sources are wrong in the same direction, the median follows them.

## Architecture

This is a monorepo with three parts:

```
┌──────────────────┐        ┌───────────────────────┐        ┌──────────────────────────┐
│  AgnetPay          │  HTTP  │  agentpay_backend       │  RPC   │  agent_pay_vault           │
│  React + Vite + TS │ ─────▶ │  FastAPI policy engine, │ ─────▶ │  Anchor program, devnet    │
│  frontend           │        │  data fetch, AI         │        │  escrow PDAs               │
│                     │        │  watchdog, wallet       │        │  release / void authority  │
└──────────────────┘        └───────────────────────┘        └──────────────────────────┘
                                        │
                                        ▼
                        Open-Meteo · ECMWF · Sentinel-2/Landsat
                        (via Agromonitoring) · Ticketmaster
```

- **`AgnetPay/`** — the frontend. Calls the backend over HTTP, shows the Playground (create/evaluate a policy) and Activity (insurer wallet + on-chain history) views.
- **`agentpay_backend/`** — a FastAPI service. Creates and evaluates policies, aggregates weather/satellite/event/delay data, computes the payout formula, pays the median amount from an insurer wallet on Solana devnet in one transaction, and writes a plain explanation of every payout (Groq, or rule-based sentences).
- **`agent_pay_vault/`** — an Anchor (Rust) escrow program deployed to Solana devnet. Not used by new policies since the median payout (nothing is held any more); kept for policies evaluated before that.

## Tech stack

- **Frontend**: React 19, TypeScript, Vite 6, `lucide-react` icons, hand-rolled CSS
- **Backend**: Python, FastAPI, `solana-py` / `solders`, httpx, an AI-assisted watchdog (Groq or Claude) for dispute explanations
- **Blockchain**: Solana devnet, Anchor 0.30.1 — a deployed vault program plus an insurer wallet that pays directly

## Deployed program

`agent_pay_vault`, Solana **devnet**, program id `CvE7xMfwbpMmCz9Pvt6RsG9tHxNUpbuG5KwyGuFHSxCk` — [view on Solana Explorer](https://explorer.solana.com/address/CvE7xMfwbpMmCz9Pvt6RsG9tHxNUpbuG5KwyGuFHSxCk?cluster=devnet).

## Setup

Each part is run separately; see each folder's own README for details.

### Frontend (`AgnetPay/`)

```sh
cd AgnetPay
npm install
cp .env.example .env.local   # point VITE_PROXY_TARGET at your backend if not localhost:8000
npm run dev
```

Requires Node.js 20.19+ or 22.12+, and the backend running.

### Backend (`agentpay_backend/`)

```sh
cd agentpay_backend
pip install -r requirements.txt
cp .env.example .env         # fill in optional keys yourself, never commit real values
uvicorn app.main:app --reload --port 8000
```

Swagger docs at `http://localhost:8000/docs`. On first start it generates two devnet wallets (`wallet.json`, `service_wallet.json`) — both gitignored, both contain private keys, never commit or share them.

### Vault program (`agent_pay_vault/`)

Anchor program, already deployed to devnet at the program id above. To rebuild it yourself:

```sh
cd agent_pay_vault
anchor build
anchor deploy --provider.cluster devnet
```

Built and deployed with the `backpackapp/build:v0.30.1` Docker image (pinned `Cargo.lock` for Anchor 0.30.1 compatibility). The backend only needs the program id and the IDL (already included at `agentpay_backend/app/idl/agent_pay_vault.json`) to talk to it — rebuilding this program is only needed if you're changing the on-chain logic itself.

None of these `.env`/`.env.local`/`.env.example` values or keypairs contain real secrets in this repository — every actual key lives only in gitignored local files.

## Status & roadmap

This is a hackathon prototype. Known gaps:

- **Premiums are a flat demo rate, not real pricing.** Every policy costs 3% of its cover, paid upfront to the insurer wallet and not refundable. There is no risk-based pricing or underwriting.
- **Travel delay data is simulated.** The other three products read live weather/satellite/event data; travel delay currently uses demo feeds only.
- **The median has a limit.** It protects against one bad source, not against two sources that are wrong in the same direction.
- **Devnet only.** Nothing here is audited or intended for mainnet funds.

## License

MIT — see [LICENSE](LICENSE).
