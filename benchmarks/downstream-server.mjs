import { createServer } from 'node:http';

const DOWNSTREAM_MS = Number(process.env.DOWNSTREAM_MS ?? 30);

const server = createServer((_req, res) => {
  const timer = setTimeout(() => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
  }, DOWNSTREAM_MS);
  res.on('close', () => clearTimeout(timer));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  process.stdout.write(`LISTENING ${port}\n`);
});
