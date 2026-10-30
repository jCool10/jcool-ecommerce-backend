// A stateful stand-in for the slice of Stripe the payment-service calls: Checkout Sessions under
// manual capture, PaymentIntent capture and cancel, idempotency keys and signed webhooks. Faults are
// injected per operation through /__control. Node built-ins only, as it runs in a bare node image.
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 12111);
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://gateway:8080/webhooks/payment';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';

let sessions = new Map();
let intents = new Map();
// Idempotency-Key → { path, status, body }, kept for every answer an endpoint produced, 5xx included.
let replies = new Map();
let inFlight = new Set();
let faults = [];
let stats = { byPi: {}, sessionsExpired: 0, faultsFired: {} };
let sink = [];

const nowSec = () => Math.floor(Date.now() / 1000);
const newId = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`;

function piStats(piId) {
  stats.byPi[piId] ??= {
    captures: 0,
    voids: 0,
    captureRequests: 0,
    keys: [],
    replays: 0,
    conflicts409: 0,
    capturesInFlight: 0,
  };
  return stats.byPi[piId];
}

class StripeRefusal {
  constructor(status, error) {
    this.status = status;
    this.body = { error };
  }
}

const missing = (kind, id, param) =>
  new StripeRefusal(404, {
    type: 'invalid_request_error',
    code: 'resource_missing',
    param,
    doc_url: 'https://stripe.com/docs/error-codes/resource-missing',
    message: `No such ${kind}: '${id}'`,
  });

const unexpectedIntentState = (intent, verb, allowed) =>
  new StripeRefusal(400, {
    type: 'invalid_request_error',
    code: 'payment_intent_unexpected_state',
    doc_url: 'https://stripe.com/docs/error-codes/payment-intent-unexpected-state',
    message: `${verb} this PaymentIntent because it has a status of ${intent.status}. Only a PaymentIntent with one of the following statuses may be ${allowed}`,
    payment_intent: publicIntent(intent),
  });

// Lazily, as nothing else would: Stripe closes an open session at expires_at by itself.
function expireIfLapsed(session) {
  if (session.status === 'open' && session.expires_at <= nowSec()) markExpired(session);
}

function markExpired(session) {
  session.status = 'expired';
  stats.sessionsExpired += 1;
}

function publicSession(session, expand = []) {
  const { orderId: _orderId, completedEvent: _event, captureMethod: _method, ...rest } = session;
  const intent = session.payment_intent && intents.get(session.payment_intent);
  return {
    ...rest,
    url: session.status === 'open' ? rest.url : null,
    payment_intent: expand.includes('payment_intent') && intent ? publicIntent(intent) : session.payment_intent,
  };
}

function publicIntent(intent) {
  const { orderId: _orderId, ...rest } = intent;
  return rest;
}

function findSession(id) {
  const session = sessions.get(id);
  if (!session) throw missing('checkout.session', id, 'session');
  expireIfLapsed(session);
  return session;
}

function findIntent(id) {
  const intent = intents.get(id);
  if (!intent) throw missing('payment_intent', id, 'intent');
  return intent;
}

function createSession(form) {
  const lines = Object.values(form.line_items ?? {});
  const amount = lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.price_data?.unit_amount), 0);
  const currency = lines[0]?.price_data?.currency;
  if (!currency || !Number.isInteger(amount) || amount <= 0) {
    throw new StripeRefusal(400, { type: 'invalid_request_error', message: 'Invalid line_items' });
  }
  const id = newId('cs_test_');
  const session = {
    id,
    object: 'checkout.session',
    mode: form.mode ?? 'payment',
    amount_total: amount,
    currency,
    status: 'open',
    payment_status: 'unpaid',
    payment_intent: null,
    url: `http://fake-stripe:${PORT}/pay/${id}`,
    success_url: form.success_url ?? null,
    cancel_url: form.cancel_url ?? null,
    client_reference_id: form.client_reference_id ?? null,
    metadata: form.metadata ?? {},
    expires_at: form.expires_at ? Number(form.expires_at) : nowSec() + 86_400,
    created: nowSec(),
    livemode: false,
    orderId: form.metadata?.order_id ?? form.client_reference_id ?? null,
    captureMethod: form.payment_intent_data?.capture_method ?? 'automatic',
  };
  sessions.set(id, session);
  return session;
}

function expireSession(id) {
  const session = findSession(id);
  if (session.status !== 'open') {
    throw new StripeRefusal(400, {
      type: 'invalid_request_error',
      message: `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${session.status}".`,
    });
  }
  markExpired(session);
  return publicSession(session);
}

function captureIntent(id) {
  const intent = findIntent(id);
  if (intent.status !== 'requires_capture') {
    throw unexpectedIntentState(
      intent,
      'This PaymentIntent could not be captured because it',
      'captured: requires_capture.',
    );
  }
  intent.status = 'succeeded';
  intent.amount_received = intent.amount;
  intent.amount_capturable = 0;
  piStats(id).captures += 1;
  return publicIntent(intent);
}

function cancelIntent(id) {
  const intent = findIntent(id);
  if (intent.status === 'succeeded' || intent.status === 'canceled') {
    throw unexpectedIntentState(
      intent,
      'You cannot cancel this PaymentIntent because it',
      'canceled: requires_payment_method, requires_capture, requires_confirmation, requires_action, processing.',
    );
  }
  intent.status = 'canceled';
  intent.amount_capturable = 0;
  piStats(id).voids += 1;
  return publicIntent(intent);
}

/** Session open → complete, with a PaymentIntent holding the amount (or taking it, without manual capture). */
function authorize(session) {
  const manual = session.captureMethod === 'manual';
  const intent = {
    id: newId('pi_'),
    object: 'payment_intent',
    amount: session.amount_total,
    amount_capturable: manual ? session.amount_total : 0,
    amount_received: manual ? 0 : session.amount_total,
    currency: session.currency,
    capture_method: manual ? 'manual' : 'automatic',
    status: manual ? 'requires_capture' : 'succeeded',
    created: nowSec(),
    livemode: false,
    metadata: {},
    orderId: session.orderId,
  };
  intents.set(intent.id, intent);
  piStats(intent.id);
  session.status = 'complete';
  session.payment_status = manual ? 'unpaid' : 'paid';
  session.payment_intent = intent.id;
  // One event per completion: a redelivery is the same event, which is what the receiver dedups on.
  session.completedEvent = {
    id: newId('evt_'),
    object: 'event',
    api_version: '2025-09-30.clover',
    created: nowSec(),
    livemode: false,
    pending_webhooks: 1,
    type: 'checkout.session.completed',
    data: { object: publicSession(session) },
  };
  return intent;
}

async function deliverWebhook(session) {
  if (!session.completedEvent) return { status: 409, error: 'session has no completed event' };
  const body = JSON.stringify(session.completedEvent);
  const timestamp = nowSec();
  const signature = `t=${timestamp},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, eventId: session.completedEvent.id };
  } catch (error) {
    return { status: null, eventId: session.completedEvent.id, error: String(error) };
  }
}

function takeFault(target) {
  const fault = faults.find((candidate) => candidate.target === target && candidate.times > 0);
  if (fault) {
    fault.times -= 1;
    const name = `${fault.mode}:${target}`;
    stats.faultsFired[name] = (stats.faultsFired[name] ?? 0) + 1;
  }
  return fault;
}

/** The API routes: [method, pattern, fault target, PaymentIntent id of the request, handler]. */
const ROUTES = [
  ['POST', /^\/v1\/checkout\/sessions$/, null, () => null, (_m, form) => publicSession(createSession(form))],
  [
    'GET',
    /^\/v1\/checkout\/sessions\/([^/]+)$/,
    null,
    () => null,
    (m, _form, query) => publicSession(findSession(m[1]), query.expand ?? []),
  ],
  ['POST', /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/, 'expire', () => null, (m) => expireSession(m[1])],
  ['GET', /^\/v1\/payment_intents\/([^/]+)$/, null, () => null, (m) => publicIntent(findIntent(m[1]))],
  ['POST', /^\/v1\/payment_intents\/([^/]+)\/capture$/, 'capture', (m) => m[1], (m) => captureIntent(m[1])],
  ['POST', /^\/v1\/payment_intents\/([^/]+)\/cancel$/, 'cancel', (m) => m[1], (m) => cancelIntent(m[1])],
];

function run(handler, match, form, query) {
  try {
    return { status: 200, body: handler(match, form, query) };
  } catch (error) {
    if (error instanceof StripeRefusal) return { status: error.status, body: error.body };
    throw error;
  }
}

const SERVER_ERROR = { error: { type: 'api_error', message: 'An unknown error occurred' } };

async function api(req, res, url, raw) {
  const route = ROUTES.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
  if (!route)
    return send(res, 404, {
      error: { type: 'invalid_request_error', message: `Unrecognized request URL (${req.method}: ${url.pathname})` },
    });
  const [, pattern, target, piOf, handler] = route;
  const match = url.pathname.match(pattern);
  const form = parseForm(raw);
  const query = parseForm(url.search.slice(1));
  query.expand = query.expand && Object.values(query.expand);
  const key = req.method === 'POST' ? req.headers['idempotency-key'] : undefined;
  const piId = piOf(match);
  const counters = piId && intents.has(piId) ? piStats(piId) : null;
  if (counters && target === 'capture') {
    counters.captureRequests += 1;
    if (key && !counters.keys.includes(key)) counters.keys.push(key);
  }

  // Stripe's order: a stored answer first, then a request still running under the key, then state.
  if (key && replies.has(key)) {
    const stored = replies.get(key);
    if (stored.path !== url.pathname) {
      return send(res, 400, {
        error: {
          type: 'idempotency_error',
          message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
        },
      });
    }
    if (counters) counters.replays += 1;
    return send(res, stored.status, stored.body, { 'idempotent-replayed': 'true', 'idempotency-key': key });
  }
  if (key && inFlight.has(key)) {
    if (counters) counters.conflicts409 += 1;
    return send(res, 409, {
      error: {
        type: 'idempotency_error',
        message: `There is currently another in-progress request using this Idempotent Key (that probably means you submitted twice, and the other request is still going through): ${key}. Please try again later.`,
      },
    });
  }

  const fault = target ? takeFault(target) : undefined;
  if (fault?.mode === 'hang') return void setTimeout(() => req.socket.destroy(), fault.ms ?? 30_000);
  // The buyer's payment lands while this call is still out, for a route keyed by its session.
  if (fault?.mode === 'webhook_first' && sessions.has(match[1])) await deliverWebhook(sessions.get(match[1]));

  const remember = (status, body) => key && replies.set(key, { path: url.pathname, status, body });
  if (fault?.mode === '500') {
    remember(500, SERVER_ERROR);
    return send(res, 500, SERVER_ERROR);
  }

  if (key) inFlight.add(key);
  const capturing = counters && target === 'capture';
  if (capturing) counters.capturesInFlight += 1;
  try {
    // Applied even when the caller has given up and closed the socket.
    if (fault?.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, fault.ms ?? 1_000));
    const result = run(handler, match, form, query);
    if (fault?.mode === 'apply_then_500') {
      remember(500, SERVER_ERROR);
      return send(res, 500, SERVER_ERROR);
    }
    remember(result.status, result.body);
    return send(res, result.status, result.body, key ? { 'idempotency-key': key } : {});
  } finally {
    if (key) inFlight.delete(key);
    if (capturing) counters.capturesInFlight -= 1;
  }
}

async function control(req, res, url, raw) {
  const body = raw ? JSON.parse(raw) : {};
  const sessionRoute = url.pathname.match(/^\/__control\/sessions\/([^/]+)\/(authorize|deliver-webhook)$/);
  if (req.method === 'POST' && sessionRoute) {
    const session = sessions.get(sessionRoute[1]);
    if (!session) return send(res, 404, { error: 'unknown session' });
    expireIfLapsed(session);
    if (sessionRoute[2] === 'authorize') {
      if (session.status !== 'open') return send(res, 409, { error: `session is ${session.status}` });
      const intent = authorize(session);
      const webhook = body.deliverWebhook ? await deliverWebhook(session) : null;
      return send(res, 200, { intentId: intent.id, webhook });
    }
    return send(res, 200, await deliverWebhook(session));
  }
  const orderRoute = url.pathname.match(/^\/__control\/orders\/([^/]+)$/);
  if (req.method === 'GET' && orderRoute) {
    const orderId = orderRoute[1];
    return send(res, 200, {
      sessions: [...sessions.values()]
        .filter((s) => s.orderId === orderId)
        .map((s) => (expireIfLapsed(s), publicSession(s))),
      intents: [...intents.values()].filter((i) => i.orderId === orderId).map(publicIntent),
    });
  }
  if (req.method === 'POST' && url.pathname === '/__control/faults') {
    faults.push({ mode: body.mode, target: body.target, times: body.times ?? 1, ms: body.ms });
    return send(res, 200, { faults });
  }
  if (req.method === 'POST' && url.pathname === '/__control/reset') {
    sessions = new Map();
    intents = new Map();
    replies = new Map();
    inFlight = new Set();
    faults = [];
    stats = { byPi: {}, sessionsExpired: 0, faultsFired: {} };
    sink = [];
    return send(res, 200, {});
  }
  if (req.method === 'GET' && url.pathname === '/__control/stats') return send(res, 200, stats);
  // A receiver of its own, for a check of the webhook signature with nothing else running.
  if (url.pathname === '/__control/webhook-sink') {
    if (req.method === 'POST') {
      sink.push({ signature: req.headers['stripe-signature'], body: raw });
      return send(res, 200, { received: true });
    }
    return send(res, 200, sink);
  }
  return send(res, 404, { error: 'unknown control route' });
}

/** `a[b][0][c]=v` into `{ a: { b: { 0: { c: 'v' } } } }`, as Stripe reads form bodies and queries. */
function parseForm(text) {
  const out = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const path = name.split(/[[\]]/).filter(Boolean);
    let node = out;
    path.forEach((segment, i) => {
      if (i === path.length - 1) node[segment] = value;
      else node = node[segment] ??= {};
    });
  }
  return out;
}

function send(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': newId('req_'), ...headers });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://fake-stripe');
    const handle =
      url.pathname === '/health'
        ? async () => send(res, 200, { ok: true })
        : url.pathname.startsWith('/__control/')
          ? control
          : api;
    handle(req, res, url, raw).catch((error) => {
      console.error(error);
      send(res, 500, SERVER_ERROR);
    });
  });
}).listen(PORT, () => console.log(`fake-stripe listening on ${PORT}`));
