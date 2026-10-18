/**
 * Sketch-hosting worker, independent of the serial bridge on port 3000.
 * Only browser assets are exposed; backend code and local configuration stay private.
 */
const path = require('node:path');
const express = require('express');
const { readSettings, validateSettings, publicSettings } = require('./settings');

/** Build the same asset routes as the Python web server, without opening a listener. */
function createWebApp(settings = readSettings()) {
  const app = express();
  const root = path.resolve(__dirname, '../..');
  app.use((req, res, next) => {
    // Reloads should fetch edited sketches and transport code, including after updates.
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
  });
  // Disable conditional cache validation as well as advertising no-store.
  const options = { etag: false, lastModified: false };
  app.get('/flipdot_config.json', (req, res) => res.json(publicSettings(settings)));
  app.get('/', (req, res) => res.sendFile(path.join(root, 'index.html'), options));
  for (const file of ['flipdot.js', 'ptixy.js']) {
    app.get(`/libs/javascript/${file}`, (req, res) => res.sendFile(path.join(__dirname, file), options));
  }
  // Mount only asset directories, rather than serving the whole repository root.
  for (const directory of ['canvas', 'ptixy', 'ptixy_player', 'static']) {
    app.use(`/${directory}`, express.static(path.join(root, directory), options));
  }
  return app;
}

if (require.main === module) {
  // The launcher passes the web port as an argument; direct runs can use the env var.
  const settings = process.env.FLIPDOT_SETTINGS ? validateSettings(JSON.parse(process.env.FLIPDOT_SETTINGS)) : readSettings();
  const port = Number(process.argv[2] || settings.webPort);
  const server = createWebApp(settings).listen(port, () => console.log(`Hosting sketches on port ${port}`));
  server.on('error', error => { console.error(error); process.exit(1); });
  if (process.send) {
    // Event-loop heartbeats let the parent replace even a hung HTTP worker.
    setInterval(() => {
      if (process.connected) process.send({ type: 'heartbeat' }, () => {});
    }, 1000);
    // Do not leave an orphaned listener behind if the supervisor disappears.
    process.on('disconnect', () => process.exit(1));
  }
}

module.exports = { createWebApp };
