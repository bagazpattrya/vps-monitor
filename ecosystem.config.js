module.exports = {
  apps: [{ name: 'vps-monitor', script: './server.js', env: { PORT: 3001, HOST: '127.0.0.1', ALLOW_LINUX_LOGIN: '0' } }]
};
