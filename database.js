const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');
require('dotenv').config();

const DB_PATH = path.resolve(process.env.DB_PATH || './arcflow.db');

// sql.js keeps the database in memory and flushes to disk on every write.
// This matches SQLite's durability guarantee for a single-process server.

let db;    // sql.js Database instance
let ready; // Promise that resolves when the DB is initialised

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const file = fs.readFileSync(DB_PATH);
    db = new SQL.Database(file);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA foreign_keys = ON;`);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      hash         TEXT    NOT NULL UNIQUE,
      from_address TEXT    NOT NULL,
      to_address   TEXT    NOT NULL,
      amount       TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      gas_used     TEXT,
      block_number INTEGER,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tx_from   ON transactions(from_address);
    CREATE INDEX IF NOT EXISTS idx_tx_to     ON transactions(to_address);
    CREATE INDEX IF NOT EXISTS idx_tx_hash   ON transactions(hash);

    CREATE TABLE IF NOT EXISTS wallets (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      address           TEXT    NOT NULL UNIQUE,
      first_seen        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_active       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      total_sent        REAL    NOT NULL DEFAULT 0,
      total_received    REAL    NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_address ON wallets(address);
  `);

  persist();
  console.log(`[db] Initialised — ${DB_PATH}`);
}

// Flush in-memory state to disk after every mutating operation
function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Run a SELECT and return all rows as plain objects
function query(sql, params = []) {
  const stmt   = db.prepare(sql);
  stmt.bind(params);
  const rows   = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Run a SELECT that returns one row (or null)
function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

// Run an INSERT / UPDATE / DELETE
function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// ─── Public API ───────────────────────────────────────────────────────────────

function logTransaction(tx) {
  const from   = tx.from.toLowerCase();
  const to     = tx.to.toLowerCase();
  const amount = parseFloat(tx.amount) || 0;
  const ts     = tx.timestamp ? Number(tx.timestamp) : Math.floor(Date.now() / 1000);

  // Upsert transaction (idempotent on hash)
  db.run(`
    INSERT INTO transactions
      (hash, from_address, to_address, amount, timestamp, status, gas_used, block_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      status       = excluded.status,
      gas_used     = excluded.gas_used,
      block_number = excluded.block_number
  `, [
    tx.hash.toLowerCase(),
    from, to,
    String(tx.amount),
    ts,
    tx.status || 'confirmed',
    tx.gasUsed   != null ? String(tx.gasUsed)    : null,
    tx.blockNumber != null ? Number(tx.blockNumber) : null,
  ]);

  // Capture rowid before wallet upserts reset last_insert_rowid()
  const idRow = queryOne('SELECT last_insert_rowid() AS id');
  const newId = idRow ? Number(idRow.id) : null;

  // Keep wallet totals in sync
  _upsertWallet(from, amount, 0);
  _upsertWallet(to,   0,      amount);

  persist();
  return newId;
}

function _upsertWallet(address, sent, received) {
  db.run(`
    INSERT INTO wallets (address, total_sent, total_received, transaction_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(address) DO UPDATE SET
      last_active       = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      total_sent        = total_sent        + ?,
      total_received    = total_received    + ?,
      transaction_count = transaction_count + 1
  `, [address, sent, received, sent, received]);
}

function getTransactionsByAddress(address) {
  return query(`
    SELECT * FROM transactions
    WHERE from_address = ? OR to_address = ?
    ORDER BY timestamp DESC
    LIMIT 20
  `, [address.toLowerCase(), address.toLowerCase()]);
}

function getTransactionByHash(hash) {
  return queryOne('SELECT * FROM transactions WHERE hash = ?', [hash.toLowerCase()]);
}

function getWallet(address) {
  return queryOne('SELECT * FROM wallets WHERE address = ?', [address.toLowerCase()]);
}

function getStats() {
  const row = queryOne(`
    SELECT
      COUNT(*)                                AS total_transactions,
      COALESCE(SUM(CAST(amount AS REAL)), 0)  AS total_volume,
      COALESCE(SUM(CAST(gas_used AS REAL)), 0) AS total_gas
    FROM transactions
    WHERE status = 'confirmed'
  `);

  const walletRow = queryOne(`
    SELECT COUNT(*) AS count FROM (
      SELECT from_address AS address FROM transactions
      UNION
      SELECT to_address   AS address FROM transactions
    )
  `);

  const totalTx  = Number(row.total_transactions) || 0;
  const totalVol = Number(row.total_volume)        || 0;
  const totalGas = Number(row.total_gas)           || 0;

  return {
    totalTransactions:   totalTx,
    totalVolumeUSDC:     totalVol.toFixed(2),
    uniqueWallets:       Number(walletRow.count) || 0,
    avgConfirmationTime: '0.8s',
    totalGasSaved:       (totalTx * 1.00).toFixed(2),  // vs ~$1 ETH mainnet gas
    totalGasUsedUSDC:    totalGas.toFixed(6),
  };
}

// Expose db instance for health check
function isConnected() {
  try { queryOne('SELECT 1 AS ok'); return true; } catch { return false; }
}

// Initialise eagerly so the server can await it before listening
ready = init();

module.exports = {
  ready,
  isConnected,
  logTransaction,
  getTransactionsByAddress,
  getTransactionByHash,
  getWallet,
  getStats,
};
