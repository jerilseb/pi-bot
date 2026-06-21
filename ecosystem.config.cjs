module.exports = {
  apps: [
    {
      name: 'pi-bot',
      // Build the web UI before the process starts so web/dist is present.
      // (npm start runs `npm run build` first; this is a safety net for `pm2 start`.)
      script: 'main.ts',
      interpreter: 'node',
      autorestart: true,
      restart_delay: 1000,
      time: true,
      watch: false,
    },
  ],
};
