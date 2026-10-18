process.on('SIGTERM', () => process.exit(0));
process.on('message', message => {
  if (message === 'crash') process.exit(17);
  if (message === 'hang') while (true) { /* Deliberately block the event loop. */ }
});
process.stdout.write('x'.repeat(2 * 1024 * 1024));
setInterval(() => process.send({ type: 'heartbeat' }), 20);
