const fs = require('fs');
const path = require('path');

const env = {};
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
} catch (_) {}

module.exports = {
  apps: [{
    name: 'gmail-mcp',
    script: 'dist/index.js',
    args: '--config /root/.gmail-multi-mcp/accounts.json',
    cwd: '/root/gmail-multi-inbox-mcp',
    // Every key in .env is forwarded, not a hand-picked subset: a value
    // present in .env but missing here silently never reaches process.env,
    // which is exactly how HOST=127.0.0.1 went unapplied on 2026-08-28 while
    // `pm2 restart --update-env` reported success.
    env: {
      PORT: '3000',
      MCP_TRANSPORT: 'http',
      ...env
    }
  }]
};
