const path = require('node:path');

const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'pi-bot',
      script: path.join(root, 'main.ts'),
      cwd: root,
      interpreter: 'node',
      autorestart: true,
      restart_delay: 1000,
      time: true,
      watch: false,
    },
    {
      name: 'pi-bot-web',
      script: path.join(root, 'node_modules/vite/bin/vite.js'),
      cwd: path.join(root, 'web'),
      interpreter: 'node',
      autorestart: true,
      restart_delay: 1000,
      time: true,
      watch: false,
    },
  ],
};
