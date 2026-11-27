// PM2 production process. The client is served by IIS (Default Web Site/TradingSystem),
// which proxies /TradingSystem/api/* to this server on 127.0.0.1 only — never exposed directly.
module.exports = {
  apps: [
    {
      name: 'trading-system-server',
      script: './dist/index.js',
      cwd: 'C:/AllMyProjetcs/TradingSystem/server', // server/.env and ./data are relative to this
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        PORT: 4500, // dev server keeps 4100
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '500M',
      error_file: 'C:/AllMyProjetcs/TradingSystem/logs/err.log',
      out_file: 'C:/AllMyProjetcs/TradingSystem/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      kill_timeout: 5000,
    },
  ],
};
