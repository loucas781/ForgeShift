'use strict';
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const SQLiteStore  = require('connect-sqlite3')(session);
const helmet       = require('helmet');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');

const authRoutes  = require('./routes/auth');
const shiftRoutes = require('./routes/shifts');
const icalRoutes  = require('./routes/ical');
const { templatesRouter, locationsRouter, usersRouter, settingsRouter } = require('./routes/api');
const { loadUser } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ENV  = process.env.NODE_ENV || 'production';

// ── Trust proxy (nginx, Cloudflare, etc.) ──────────────────────────────────
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY) || 1);
}

// ── Security headers ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],    // inline scripts in HTML
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── Compression ────────────────────────────────────────────────────────────
app.use(compression());

// ── Logging ────────────────────────────────────────────────────────────────
if (ENV !== 'test') {
  app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));
}

// ── Body parsers ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// ── Session ────────────────────────────────────────────────────────────────
const sessionDbDir = path.dirname(process.env.SESSION_DB_PATH || './data/sessions.db');
if (!fs.existsSync(sessionDbDir)) fs.mkdirSync(sessionDbDir, { recursive: true });

app.use(session({
  store: new SQLiteStore({
    db:  path.basename(process.env.SESSION_DB_PATH || 'sessions.db'),
    dir: path.dirname(path.resolve(process.env.SESSION_DB_PATH || './data/sessions.db')),
  }),
  secret:            process.env.SESSION_SECRET || 'INSECURE_DEFAULT_CHANGE_IN_PRODUCTION',
  resave:            false,
  saveUninitialized: false,
  name:              'forgeshift.sid',
  cookie: {
    secure:   process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    sameSite: process.env.COOKIE_SAME_SITE || 'strict',
    maxAge:   parseInt(process.env.SESSION_MAX_AGE) || 7 * 24 * 60 * 60 * 1000,
  },
}));

// ── Rate limiting ──────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs:        parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:             parseInt(process.env.RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests, please slow down.' },
}));

// ── Load user into res.locals ──────────────────────────────────────────────
app.use(loadUser);

// ── Static files ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: ENV === 'production' ? '1d' : 0,
  etag:   true,
}));

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/shifts',    shiftRoutes);
app.use('/api/ical',      icalRoutes);
app.use('/api/templates', templatesRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/users',     usersRouter);
app.use('/api/settings',  settingsRouter);

// ── Load version info ─────────────────────────────────────────────────────
let versionInfo = { version: '1.0.0', build: 0, commit: 'local', branch: 'main', builtAt: null };
try {
  versionInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '../version.json'), 'utf8'));
} catch { /* version.json missing — use defaults */ }

// ── App config endpoint (exposes non-sensitive env info to client) ─────────
app.get('/api/config', (req, res) => {
  res.json({
    environment: ENV,
    appName:     process.env.APP_NAME || 'ForgeShift',
    version:     versionInfo.version,
    build:       versionInfo.build,
    commit:      versionInfo.commit,
    branch:      versionInfo.branch,
    builtAt:     versionInfo.builtAt,
  });
});

// ── SPA catch-all – serve index.html for all non-API routes ───────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.stack || err.message);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
  res.status(status).send('Server error');
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`\n🚀 ForgeShift running`);
  console.log(`   Environment : ${ENV}`);
  console.log(`   Address     : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   DB          : ${process.env.DB_PATH || './data/forgeshift.db'}\n`);
});

module.exports = app;
