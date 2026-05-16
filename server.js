require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const corsMiddleware = require('./middleware/cors');
const { ready, isConnected } = require('./database');

const transactionsRouter = require('./routes/transactions');
const walletsRouter      = require('./routes/wallets');
const statsRouter        = require('./routes/stats');

const app  = express();
const PORT = process.env.PORT || 3001;
const START_TIME = Date.now();

// ─── Security & Parsing ───────────────────────────────────────────────────────

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(corsMiddleware);
app.use(express.json({ limit: '16kb' }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 120,             // 120 requests / min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please slow down' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,              // 30 writes / min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Write rate limit exceeded' },
});

app.use('/api/', apiLimiter);
app.use('/api/transactions', writeLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/transactions', transactionsRouter);
app.use('/api/wallet',       walletsRouter);
app.use('/api/stats',        statsRouter);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const dbStatus = isConnected() ? 'connected' : 'error';

  res.json({
    status:   'ok',
    uptime:   Math.floor((Date.now() - START_TIME) / 1000),
    database: dbStatus,
    network:  'Arc Testnet',
    chainId:  5042002,
    version:  '1.0.0',
    env:      process.env.NODE_ENV || 'development',
  });
});

// Root — friendly message for anyone hitting the API base URL
app.get('/', (req, res) => {
  res.json({
    name:    'ArcFlow API',
    version: '1.0.0',
    docs:    'https://github.com/remon550/arcflow',
    health:  '/api/health',
    endpoints: [
      'POST   /api/transactions',
      'GET    /api/transactions/:address',
      'GET    /api/transactions/status/:hash',
      'GET    /api/wallet/:address',
      'GET    /api/stats',
      'GET    /api/health',
    ],
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  console.error(`[${new Date().toISOString()}] ${status} ${req.method} ${req.path} — ${err.message}`);
  res.status(status).json({ success: false, error: message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Wait for async DB init then start
ready.then(() => app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║        ArcFlow API  v1.0.0               ║
  ╠══════════════════════════════════════════╣
  ║  Local:    http://localhost:${PORT}         ║
  ║  Network:  Arc Testnet (Chain 5042002)   ║
  ║  DB:       ${(process.env.DB_PATH || './arcflow.db').padEnd(30)}║
  ║  Env:      ${(process.env.NODE_ENV || 'development').padEnd(30)}║
  ╚══════════════════════════════════════════╝

  Endpoints:
    GET  /api/health
    GET  /api/stats
    POST /api/transactions
    GET  /api/transactions/:address
    GET  /api/transactions/status/:hash
    GET  /api/wallet/:address
  `);
})).catch(err => { console.error('[fatal] DB init failed:', err); process.exit(1); });

module.exports = app;
