// An id-service replica the spec can steer: POST /__mode/{ok|503|hang}; GET /__hits counts mints it saw.
// A mint whose body is not the one the spec sends is refused with 400, so a retry that lost its body shows.
const http = require('node:http');
const { hostname } = require('node:os');

const EXPECTED_BODY = JSON.stringify({ bucket: 0 });

let mode = 'ok';
let hits = 0;

http
  .createServer((req, res) => {
    const control = /^\/__mode\/(ok|503|hang)$/.exec(req.url ?? '');
    if (control) {
      mode = control[1];
      res.end(mode);
      return;
    }
    if (req.url === '/__hits') {
      res.end(String(hits));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hits += 1;
      if (mode === 'hang') return;
      const status = body !== EXPECTED_BODY ? 400 : mode === '503' ? 503 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ replica: hostname(), code: status === 503 ? 'LEASE_NOT_HELD' : undefined }));
    });
  })
  .listen(3000);
