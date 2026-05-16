# ArcFlow Backend API

Transaction logging and analytics API for [ArcFlow](https://arcflow.live) — a USDC payment interface built on [Arc Network](https://www.arc.io).

Built for the Circle + Arc Hackathon.

---

## What It Does

ArcFlow's backend persists every USDC transfer that happens through the app and exposes a clean REST API for the frontend to consume. It runs alongside the MetaMask + ethers.js frontend to provide:

- **Durable transaction history** — survives page refreshes and cleared localStorage
- **Wallet profiles** — total sent/received, first seen, last active
- **Live stats** — real volume, unique wallets, gas savings vs Ethereum mainnet
- **Transaction status** — query any tx hash logged through ArcFlow

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 18+ | Universal, well-supported on all hosts |
| Framework | Express 4 | Minimal, battle-tested |
| Database | SQLite via sql.js | Zero setup, file-based, works on any machine |
| Security | Helmet + CORS + Rate Limiting | Production-safe out of the box |

---

## Install & Run

```bash
# 1. Clone or navigate to the backend folder
cd arcflow-backend

# 2. Install dependencies (no native compilation needed)
npm install

# 3. Copy environment variables
cp .env.example .env

# 4. Start the server
npm start
# → http://localhost:3001
```

For development with auto-restart:
```bash
npm install -D nodemon
npm run dev
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP port |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` | Arc Testnet RPC endpoint |
| `USDC_CONTRACT` | `0x3600...0000` | USDC ERC-20 contract on Arc |
| `FRONTEND_URL` | `https://arcflow.live` | Allowed CORS origin |
| `NODE_ENV` | `development` | Set to `production` on deploy |
| `DB_PATH` | `./arcflow.db` | SQLite database file path |

---

## API Reference

Base URL (local): `http://localhost:3001`  
Base URL (production): `https://api.arcflow.live`

---

### `GET /api/health`

Server and database status.

```bash
curl http://localhost:3001/api/health
```

```json
{
  "status": "ok",
  "uptime": 42,
  "database": "connected",
  "network": "Arc Testnet",
  "chainId": 5042002,
  "version": "1.0.0",
  "env": "development"
}
```

---

### `GET /api/stats`

Aggregate stats across all logged transactions.

```bash
curl http://localhost:3001/api/stats
```

```json
{
  "totalTransactions": 142,
  "totalVolumeUSDC": "35420.00",
  "uniqueWallets": 38,
  "avgConfirmationTime": "0.8s",
  "totalGasSaved": "142.00",
  "totalGasUsedUSDC": "1.278000"
}
```

> `totalGasSaved` = transactions × ~$1.00 (typical ETH mainnet gas cost per transfer).  
> On Arc, gas is paid in USDC at a fraction of a cent — that's the saving.

---

### `POST /api/transactions`

Log a confirmed USDC transfer. Called by the frontend after MetaMask confirms the tx.

```bash
curl -X POST http://localhost:3001/api/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "hash":        "0xabc123...",
    "from":        "0x1111...1111",
    "to":          "0x2222...2222",
    "amount":      "250.00",
    "timestamp":   1748000000,
    "status":      "confirmed",
    "gasUsed":     "0.009",
    "blockNumber": 12345
  }'
```

```json
{ "success": true, "id": 7 }
```

**Idempotent** — posting the same `hash` twice updates the existing record rather than creating a duplicate.

---

### `GET /api/transactions/:address`

Last 20 transactions for a wallet (sent or received), newest first.

```bash
curl http://localhost:3001/api/transactions/0x1111111111111111111111111111111111111111
```

```json
{
  "transactions": [
    {
      "id": 4,
      "hash": "0xabc123...",
      "from": "0x3333...3333",
      "to": "0x1111...1111",
      "amount": "500.00",
      "status": "confirmed",
      "blockNumber": 12350,
      "gasUsed": "0.011",
      "timestamp": 1748001000,
      "createdAt": "2025-01-05T12:00:00Z",
      "direction": "in"
    }
  ],
  "total": 4
}
```

`direction` is `"in"` (received) or `"out"` (sent) relative to the queried address.

---

### `GET /api/transactions/status/:hash`

Status of a specific transaction by hash.

```bash
curl http://localhost:3001/api/transactions/status/0xabc123...
```

```json
{
  "hash":        "0xabc123...",
  "status":      "confirmed",
  "blockNumber": 12345,
  "gasUsed":     "0.009",
  "from":        "0x1111...1111",
  "to":          "0x2222...2222",
  "amount":      "250.00",
  "timestamp":   1748000000,
  "createdAt":   "2025-01-05T12:00:00Z"
}
```

---

### `GET /api/wallet/:address`

Aggregated profile for a wallet address.

```bash
curl http://localhost:3001/api/wallet/0x1111111111111111111111111111111111111111
```

```json
{
  "address":          "0x1111...1111",
  "totalSent":        "500.00",
  "totalReceived":    "1000.00",
  "transactionCount": 4,
  "firstSeen":        "2025-01-01T09:00:00Z",
  "lastActive":       "2025-01-05T12:00:00Z"
}
```

Returns a zeroed profile (not 404) for wallets with no ArcFlow history yet.

---

## Arc Testnet Integration

| Property | Value |
|----------|-------|
| Network | Arc Testnet |
| Chain ID | `5042002` |
| RPC URL | `https://rpc.testnet.arc.network` |
| Native Currency | USDC (18 decimals) — gas paid in USDC, not ETH |
| USDC Contract | `0x3600000000000000000000000000000000000000` |
| Block Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |

Arc is an EVM-compatible L1 where **USDC is the native gas token**. There is no ETH. This API tracks native USDC transfers (not ERC-20 transfers) made through the ArcFlow frontend.

---

## Circle Products Used

| Product | Usage |
|---------|-------|
| **Circle USDC** | The transfer token and gas currency on Arc Testnet |
| **Circle Faucet** (`faucet.circle.com`) | Users obtain testnet USDC here to fund their wallets |
| **CCTP (Cross-Chain Transfer Protocol)** | Arc's bridge infrastructure for moving USDC from other chains |

---

## Project Structure

```
arcflow-backend/
├── server.js           Main Express app, rate limiting, error handling
├── database.js         SQLite schema, prepared queries, write helpers
├── routes/
│   ├── transactions.js POST log + GET by address + GET status by hash
│   ├── wallets.js      GET wallet profile
│   └── stats.js        GET aggregate stats
├── middleware/
│   ├── cors.js         Origin allowlist (arcflow.live + localhost)
│   └── validate.js     Input validation (address, hash, amount formats)
├── .env                Local environment (not committed)
├── .env.example        Template for production deploy
├── arcflow.db          SQLite database file (auto-created on first run)
└── package.json
```

---

## Frontend Integration

The frontend calls this API at three points:

1. **After a successful send** (`dashboard.html`) — `POST /api/transactions`
2. **On dashboard load** (`dashboard.html`) — `GET /api/transactions/:address` replaces localStorage history
3. **On landing page load** (`index.html`) — `GET /api/stats` drives the live stats counters

Switch between environments by changing `BACKEND_URL` at the top of each HTML file:

```js
// Local dev
const BACKEND_URL = 'http://localhost:3001';

// Production
const BACKEND_URL = 'https://api.arcflow.live';
```
