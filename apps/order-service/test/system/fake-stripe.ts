import { resolve } from 'node:path';
import { GenericContainer, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';

export const FAKE_STRIPE_PORT = 12111;

export type StripeFault = {
  /** `webhook_first` delivers the session's webhook while it holds the call. */
  mode: 'slow' | 'hang' | '500' | 'apply_then_500' | 'webhook_first';
  target: 'capture' | 'expire';
  times?: number;
  ms?: number;
};

export interface IntentStats {
  captures: number;
  voids: number;
  captureRequests: number;
  keys: string[];
  replays: number;
  conflicts409: number;
  capturesInFlight: number;
}

export interface FakeStripeStats {
  byPi: Record<string, IntentStats>;
  sessionsExpired: number;
  /** `<mode>:<target>` → how many requests the fault took. */
  faultsFired: Record<string, number>;
}

export interface FakeIntent {
  id: string;
  status: string;
  amount: number;
  amount_received: number;
  currency: string;
  orderId: string | null;
}

export function startFakeStripe(
  network: StartedNetwork,
  env: { PAYMENT_WEBHOOK_SECRET: string; WEBHOOK_URL?: string },
): Promise<StartedTestContainer> {
  return new GenericContainer('node:24-alpine')
    .withNetwork(network)
    .withNetworkAliases('fake-stripe')
    .withEnvironment({ PORT: String(FAKE_STRIPE_PORT), ...env })
    .withCopyFilesToContainer([{ source: resolve(__dirname, 'fixtures/fake-stripe.mjs'), target: '/fake-stripe.mjs' }])
    .withCommand(['node', '/fake-stripe.mjs'])
    .withExposedPorts(FAKE_STRIPE_PORT)
    .withWaitStrategy(Wait.forHttp('/health', FAKE_STRIPE_PORT))
    .start();
}

/** The fake's control surface, read through its mapped port. */
export class FakeStripeControl {
  constructor(private readonly baseUrl: () => string) {}

  apiAddress(): { host: string; port: number; protocol: 'http' } {
    const url = new URL(this.baseUrl());
    return { host: url.hostname, port: Number(url.port), protocol: 'http' };
  }

  async authorize(sessionId: string, { deliverWebhook }: { deliverWebhook: boolean }) {
    return this.post(`/__control/sessions/${sessionId}/authorize`, { deliverWebhook }) as Promise<{
      status: number;
      body: { intentId: string; webhook: { status: number | null } | null };
    }>;
  }

  async deliverWebhook(sessionId: string): Promise<{ status: number | null; eventId: string }> {
    return (await this.command(`/__control/sessions/${sessionId}/deliver-webhook`)) as {
      status: number | null;
      eventId: string;
    };
  }

  async setFault(fault: StripeFault): Promise<void> {
    await this.command('/__control/faults', fault);
  }

  async reset(): Promise<void> {
    await this.command('/__control/reset');
  }

  async faultsFired(): Promise<Record<string, number>> {
    return (await this.stats()).faultsFired;
  }

  async stats(): Promise<FakeStripeStats> {
    return (await this.get('/__control/stats')) as FakeStripeStats;
  }

  async intentStats(piId: string): Promise<IntentStats> {
    return (await this.stats()).byPi[piId];
  }

  async ofOrder(orderId: string): Promise<{ sessions: { id: string; status: string }[]; intents: FakeIntent[] }> {
    return (await this.get(`/__control/orders/${orderId}`)) as {
      sessions: { id: string; status: string }[];
      intents: FakeIntent[];
    };
  }

  async webhookSink(): Promise<{ signature: string; body: string }[]> {
    return (await this.get('/__control/webhook-sink')) as { signature: string; body: string }[];
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl()}${path}`);
    if (!res.ok) throw new Error(`fake-stripe ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** For a control call whose refusal a scenario asserts on. */
  private async post(path: string, body: unknown = {}): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  /** Must go through: a fault that failed to arm would leave the scenario testing nothing. */
  private async command(path: string, body: unknown = {}): Promise<unknown> {
    const res = await this.post(path, body);
    if (res.status !== 200) throw new Error(`fake-stripe ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
}
