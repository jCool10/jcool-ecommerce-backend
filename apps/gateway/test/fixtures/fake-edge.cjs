// Stands in for Railway's edge in front of the gateway. Every test request comes from the same host,
// so the client address the edge would see on the socket is taken from `x-test-client-ip` instead.
// Like the edge, it overwrites any X-Real-IP the client sent and appends to its X-Forwarded-For.
const http = require('node:http');

const [host, port] = (process.env.UPSTREAM ?? 'gateway:8080').split(':');

http
  .createServer((req, res) => {
    const headers = { ...req.headers };
    const client = headers['x-test-client-ip'];
    delete headers['x-test-client-ip'];
    headers['x-real-ip'] = client;
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${client}` : client;
    headers['x-forwarded-proto'] = 'https';
    // IPv4, as Railway's edge arrives from 100.64.0.0/10, and so a single address for the test to trust.
    const upstream = http.request({ host, port, family: 4, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  })
  .listen(3000, '::');
