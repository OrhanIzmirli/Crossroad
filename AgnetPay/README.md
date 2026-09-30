# Crossroad

*Formerly Agent Pay.* Where agents meet payments.

Parametric insurance that settles itself: two independent data sources decide the payout, and the money moves on Solana the moment the rule is hit — no adjuster, no claim form, no waiting.

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

Each product ships with a sensible default rule (trigger/exit values) that can be adjusted, or replaced entirely with a custom rule (direction, thresholds, satellite settings).

## How a payout is decided

```
payout_ratio = clamp((trigger − observed) / (trigger − exit), 0, 1)
```

- Every source's reading is turned into a payout ratio with the policy's own rule.
- The payout is the **median** of those ratios (the middle reading), paid in full on-chain at once. With three weather models, one broken or manipulated source is outvoted and cannot change the payout on its own.
- Nothing is held back and nobody has to approve anything. When the sources disagree, an AI watchdog explains why and flags anything that looks like a fault for a later audit; it never sets, changes or stops a payment.
- Known limit: if two sources are wrong in the same direction, the median follows them.

## Architecture

This repository contains the **frontend only**: a React + TypeScript single-page app that talks to a separate backend service over HTTP.

```
┌─────────────────┐        ┌──────────────────────┐        ┌────────────────┐
│  React frontend  │  HTTP  │   Backend API         │  RPC   │  Solana devnet  │
│  (this repo)      │ ─────▶ │  (policy engine,      │ ─────▶ │  insurer wallet │
│  Vite + TS         │        │   weather/data fetch, │        │                 │
└─────────────────┘        │   AI watchdog)         │        └────────────────┘
                            └──────────────────────┘
                                       │
                                       ▼
                        Open-Meteo (best match · ECMWF · DWD ICON) · Sentinel-2/Landsat
                        (via Agromonitoring) · Ticketmaster
```

The backend creates and evaluates policies, fetches weather/satellite/delay/event data, computes the payout formula, and submits transactions from an insurer wallet on Solana devnet. It is deployed separately and is not part of this repository.

## Tech stack

- **Frontend**: React 19, TypeScript, Vite 6, `lucide-react` icons, hand-rolled CSS (no UI framework)
- **Backend** (external service, called over HTTP): policy engine, weather/satellite/event/delay data aggregation, AI-written plain explanations of every payout
- **Blockchain**: Solana devnet — an insurer wallet pays the median amount directly, in one transaction

## Setup

Requires Node.js 20.19+ or 22.12+, and a running backend (see [Architecture](#architecture)).

```sh
npm install
cp .env.example .env.local   # edit if your backend runs somewhere other than localhost:8000
npm run dev
```

Open the local URL printed by Vite. To create a production build:

```sh
npm run build
npm run preview
```

### Configuration

| Variable | Purpose | Default |
|---|---|---|
| `VITE_PROXY_TARGET` | Dev-only: where the Vite dev server proxies `/api` requests | `http://localhost:8000` |
| `VITE_API_BASE_URL` | Production: base URL the built app calls directly | — |
| `VITE_SOLANA_CLUSTER` | Cluster used for Explorer links only | `devnet` |

These values are public and get baked into the client bundle at build time — never put secrets in them. `.env.example` documents the shape; copy it to `.env.local` for local development. There are no API keys or private keys anywhere in this frontend.

## API surface (backend)

- `GET /products` — the product catalog (labels, units, default rules, themes)
- `POST /policy`, `GET /policy/{id}`
- `POST /policy/{id}/evaluate` — optional `{simulate: [{mm, label}]}` for demo readings
- `POST /policy/{id}/resolve?release=true|false` — only for policies evaluated before median settlement that still hold an escrow
- `GET /wallet/balance` — `{address, balance_sol}`
- `GET /wallet/history` — `{address, transactions: [{signature, slot, err}]}`

Creating a policy charges the premium; evaluating it sends one real devnet payment of the median amount. No request is made on page load, duplicate submissions are blocked while one is pending, and POST requests are never retried automatically — a returned signature means "submitted", not "confirmed".

## Project layout

- `src/main.tsx` — the Playground and Activity dashboard
- `src/Landing.tsx` — the marketing/overview page
- `src/api.ts` — the API client and shared types
- `src/styles.css`, `src/workspace.css`, `src/landing.css` — the visual system
- `docs/` — screenshots used during development

## Status & roadmap

This is a hackathon prototype. Known gaps:

- **Premiums are a flat demo rate, not real pricing.** Every policy costs 3% of its cover (`PREMIUM_RATE`), paid upfront to the insurer wallet and not refundable: from the demo wallet by the backend, or signed by the policyholder in Phantom / a browser-created wallet and verified on-chain before the policy is created. There is no risk-based pricing or underwriting.
- **Travel delay data is simulated.** The other three products read live weather/satellite/event data; travel delay currently uses demo feeds only.
- **No persistence guarantees beyond the backend's own storage** — policies and escrow state live in the backend service, not on this frontend.
- **Devnet only.** Nothing here is audited or intended for mainnet funds.

### Known limitations (deliberately out of scope)

1. **Risk pricing is not solved.** The 3% premium is symbolic: it only shows that higher cover costs more. A real premium would depend on region, season, historical data and risk level.
2. **No insurable-interest verification.** The system does not check that the location or event a user declares is really theirs (field ownership, ticket or organiser status). That needs a separate identity / land-registry (KYC) layer. There is also no check at sign-up that the pinned spot is farmland at all: the satellite NDVI reading is an optional third vote at evaluation time (crop products only, and only with `AGROMONITORING_API_KEY` set). It says whether vegetation at the pin looks healthy, not whose land it is.
3. **This project answers "how is a payout computed and paid reliably from live data?"**, not "who is entitled to be insured?" (underwriting / KYC).

## License

MIT — see the repository root [LICENSE](../LICENSE).
