// PM2 Ecosystem Configuration
// Usage:
//   pm2 start ecosystem.config.js --env production
//   pm2 start ecosystem.config.js --env staging
//   pm2 start ecosystem.config.js --env development
//
// Install PM2: npm install -g pm2
// Auto-start on reboot: pm2 startup && pm2 save

module.exports = {
  apps: [
    // ── Production ──────────────────────────────────────────────────────
    {
      name:         'forgeshift-prod',
      script:       'src/server.js',
      instances:    'max',          // Cluster mode – use all CPU cores
      exec_mode:    'cluster',
      watch:        false,
      max_memory_restart: '500M',
      env_production: {
        NODE_ENV:        'production',
        PORT:            3000,
        HOST:            '127.0.0.1',
        DB_PATH:         './data/forgeshift.db',
        SESSION_DB_PATH: './data/sessions.db',
        TRUST_PROXY:     1,
        COOKIE_SECURE:   'true',
      },
    },

    // ── Staging ─────────────────────────────────────────────────────────
    {
      name:      'forgeshift-staging',
      script:    'src/server.js',
      instances: 1,
      watch:     false,
      env_staging: {
        NODE_ENV:        'staging',
        PORT:            3001,
        HOST:            '127.0.0.1',
        DB_PATH:         './data/forgeshift-staging.db',
        SESSION_DB_PATH: './data/sessions-staging.db',
        TRUST_PROXY:     1,
        COOKIE_SECURE:   'true',
      },
    },

    // ── Development ─────────────────────────────────────────────────────
    {
      name:      'forgeshift-dev',
      script:    'src/server.js',
      instances: 1,
      watch:     ['src'],
      ignore_watch: ['node_modules', 'data', 'public'],
      env_development: {
        NODE_ENV:        'development',
        PORT:            3002,
        HOST:            '0.0.0.0',
        DB_PATH:         './data/forgeshift-dev.db',
        SESSION_DB_PATH: './data/sessions-dev.db',
        TRUST_PROXY:     0,
        COOKIE_SECURE:   'false',
      },
    },
  ],
};
