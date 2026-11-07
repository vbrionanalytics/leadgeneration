// PM2 process file. From the repo root: pm2 start deploy/ecosystem.config.cjs && pm2 save
const path = require('path');
const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'leadgen-api',
      cwd: path.join(root, 'server'),
      script: 'dist/index.js',
      node_args: '--enable-source-maps',
      env: { NODE_ENV: 'production', RUN_WORKER: 'false' },
      max_memory_restart: '600M',
      time: true
    },
    {
      name: 'leadgen-worker',
      cwd: path.join(root, 'server'),
      script: 'dist/jobs/worker.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '600M',
      time: true
    },
    {
      name: 'leadgen-analyzer',
      cwd: path.join(root, 'analyzer'),
      script: '.venv/bin/uvicorn',
      args: 'app.main:app --host 127.0.0.1 --port 8000 --workers 2 --env-file .env',
      interpreter: 'none',
      time: true
    }
  ]
};
