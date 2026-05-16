// Lightweight input validation — no external deps needed

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH     = /^0x[0-9a-fA-F]{64}$/;
const AMOUNT      = /^\d+(\.\d{1,18})?$/;

function isAddress(v) { return ETH_ADDRESS.test(v); }
function isHash(v)    { return TX_HASH.test(v); }
function isAmount(v)  { return AMOUNT.test(String(v)) && parseFloat(v) >= 0; }

// POST /api/transactions body validator
function validateTransaction(req, res, next) {
  const { hash, from, to, amount, timestamp, status } = req.body;
  const errors = [];

  if (!hash    || !isHash(hash))      errors.push('hash: must be a valid 0x transaction hash');
  if (!from    || !isAddress(from))   errors.push('from: must be a valid 0x Ethereum address');
  if (!to      || !isAddress(to))     errors.push('to: must be a valid 0x Ethereum address');
  if (!amount  || !isAmount(amount))  errors.push('amount: must be a non-negative number');
  if (timestamp && isNaN(Number(timestamp))) errors.push('timestamp: must be a Unix timestamp');

  const allowed = ['pending', 'confirmed', 'failed'];
  if (status && !allowed.includes(status)) {
    errors.push(`status: must be one of ${allowed.join(', ')}`);
  }

  if (errors.length) {
    return res.status(400).json({ success: false, errors });
  }
  next();
}

// GET /:address param validator
function validateAddress(req, res, next) {
  if (!isAddress(req.params.address)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid Ethereum address — must be a 42-character 0x hex string',
    });
  }
  next();
}

// GET /status/:hash param validator
function validateHash(req, res, next) {
  if (!isHash(req.params.hash)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid transaction hash — must be a 66-character 0x hex string',
    });
  }
  next();
}

module.exports = { validateTransaction, validateAddress, validateHash };
