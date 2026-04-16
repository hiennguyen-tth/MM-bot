'use strict';

// PM2 Ecosystem — MM Bot SaaS
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup

module.exports = {
    apps: [
        // ── API Server ────────────────────────────────────────────────────────
        {
            name: 'mmbot-api',
            script: './saas/api/src/app.js',
            cwd: '/home/ubuntu/mm-bot',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',

            // Do NOT restart on clean exit (circuit-breaker exits 0)
            stop_exit_codes: [0],

            env: {
                NODE_ENV: 'production',
                PORT: '3000',
                // Secrets injected from /etc/mmbot.env (sourced in setup.sh)
                // PM2 will inherit env vars from the shell that runs `pm2 start`
            },

            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: './logs/api-error.log',
            out_file: './logs/api-out.log',
            merge_logs: true,
        },

        // ── BullMQ Worker (bot instance manager) ─────────────────────────────
        {
            name: 'mmbot-worker',
            script: './saas/api/src/workers/botWorker.js',
            cwd: '/home/ubuntu/mm-bot',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',

            stop_exit_codes: [0],

            env: {
                NODE_ENV: 'production',
            },

            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: './logs/worker-error.log',
            out_file: './logs/worker-out.log',
            merge_logs: true,
        },
    ],
};
