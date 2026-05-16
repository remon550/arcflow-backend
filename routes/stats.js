const { Router } = require('express');
const { getStats } = require('../database');

const router = Router();

// ─── GET /api/stats ───────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const stats = getStats();
  res.json(stats);
});

module.exports = router;
