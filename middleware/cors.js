const cors = require('cors');

// Allow any arcflow.live subdomain + localhost dev origins
const ORIGIN_PATTERN = /^https:\/\/([a-z0-9-]+\.)?arcflow\.live$/;

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'https://arcflow-five.vercel.app',
];

module.exports = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ORIGIN_PATTERN.test(origin)) return callback(null, true);
    if (DEV_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
});
