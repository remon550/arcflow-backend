const { Router } = require('express');
const {
  logTransaction,
  getTransactionsByAddress,
  getTransactionByHash,
} = require('../database');
const {
  validateTransaction,
  validateAddress,
  validateHash,
} = require('../middleware/validate');

const router = Router();

// ─── POST /api/transactions ───────────────────────────────────────────────────
// Log a USDC transfer that was confirmed on Arc Testnet.
router.post('/', validateTransaction, (req, res) => {
  try {
    const id = logTransaction(req.body);
    res.status(201).json({ success: true, id });
  } catch (err) {
    // Duplicate hash — idempotent upsert already handled in DB layer,
    // but surface a friendly message just in case.
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({
        success: false,
        error: 'Transaction with this hash already exists',
      });
    }
    throw err; // let the global error handler deal with it
  }
});

// ─── GET /api/transactions/status/:hash ──────────────────────────────────────
// Must be defined BEFORE /:address so "status" isn't captured as an address.
router.get('/status/:hash', validateHash, (req, res) => {
  const tx = getTransactionByHash(req.params.hash);
  if (!tx) {
    return res.status(404).json({
      success: false,
      error: 'Transaction not found in ArcFlow database',
    });
  }

  res.json({
    hash:        tx.hash,
    status:      tx.status,
    blockNumber: tx.block_number,
    gasUsed:     tx.gas_used,
    from:        tx.from_address,
    to:          tx.to_address,
    amount:      tx.amount,
    timestamp:   tx.timestamp,
    createdAt:   tx.created_at,
  });
});

// ─── GET /api/transactions/:address ──────────────────────────────────────────
// Returns the last 20 transactions for a wallet (sent or received).
router.get('/:address', validateAddress, (req, res) => {
  const txs = getTransactionsByAddress(req.params.address);

  const formatted = txs.map((tx) => ({
    id:          tx.id,
    hash:        tx.hash,
    from:        tx.from_address,
    to:          tx.to_address,
    amount:      tx.amount,
    status:      tx.status,
    blockNumber: tx.block_number,
    gasUsed:     tx.gas_used,
    timestamp:   tx.timestamp,
    createdAt:   tx.created_at,
    // Convenience flag for the frontend
    direction:   tx.from_address === req.params.address.toLowerCase() ? 'out' : 'in',
  }));

  res.json({ transactions: formatted, total: formatted.length });
});

module.exports = router;
