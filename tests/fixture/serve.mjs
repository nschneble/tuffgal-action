import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const server = createServer(async (request, response) => {
  const path = request.url === '/' ? '/index.html' : request.url ?? '/index.html';
  try {
    const body = await readFile(join(dir, 'public', path.slice(1)));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  }
});

server.listen(PORT, () => {
  process.stdout.write(`fixture server listening on ${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
