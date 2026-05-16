const { Router } = require('express');
const { getWallet } = require('../database');
const { validateAddress } = require('../middleware/validate');

const router = Router();

// ─── GET /api/wallet/:address ─────────────────────────────────────────────────
router.get('/:address', validateAddress, (req, res) => {
  const wallet = getWallet(req.params.address);

  if (!wallet) {
    // Return a zeroed profile — wallet exists on-chain but has no ArcFlow history yet
    return res.json({
      address:          req.params.address.toLowerCase(),
      totalSent:        '0.00',
      totalReceived:    '0.00',
      transactionCount: 0,
      firstSeen:        null,
      lastActive:       null,
    });
  }

  res.json({
    address:          wallet.address,
    totalSent:        parseFloat(wallet.total_sent).toFixed(2),
    totalReceived:    parseFloat(wallet.total_received).toFixed(2),
    transactionCount: wallet.transaction_count,
    firstSeen:        wallet.first_seen,
    lastActive:       wallet.last_active,
  });
});

module.exports = router;
