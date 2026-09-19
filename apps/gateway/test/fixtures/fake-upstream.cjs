// An upstream that answers every request with what it received: its own NAME, the method, the url, the
// headers and the body (base64, so a byte that changed on the way shows). GET /__hits counts the rest.
const http = require('node:http');

const NAME = process.env.NAME ?? 'upstream';
let hits = 0;

http
  .createServer((req, res) => {
    if (req.url === '/__hits') {
      res.end(String(hits));
      return;
    }
    hits += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': [
          'refresh=r; Path=/auth; Expires=Wed, 01 Oct 2036 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict',
          'csrf=c; Path=/; Secure; SameSite=Strict',
        ],
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
      });
      res.end(
        JSON.stringify({
          upstream: NAME,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('base64'),
        }),
      );
    });
  })
  .listen(3000, '::');
