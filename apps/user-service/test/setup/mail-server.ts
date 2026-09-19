import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const MAIL_IMAGE = 'axllent/mailpit:v1.31.1';
const SMTP_PORT = 1025;
const API_PORT = 8025;

/** Refused immediately, unlike stopping the container under requests still in flight. */
export const UNREACHABLE_SMTP_URL = 'smtp://127.0.0.1:1';

export interface CapturedMail {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

export interface StartedMailServer {
  smtpUrl: string;
  /** Newest first. */
  messages(): Promise<CapturedMail[]>;
  waitForMail(address: string, count?: number, timeoutMs?: number): Promise<CapturedMail[]>;
  body(id: string): Promise<string>;
  clear(): Promise<void>;
  stop(): Promise<void>;
}

/** Per spec file: only the mail suite needs one. */
export async function startMailServer(): Promise<StartedMailServer> {
  const container: StartedTestContainer = await new GenericContainer(MAIL_IMAGE)
    .withExposedPorts(SMTP_PORT, API_PORT)
    // `/readyz` answers before the SMTP listener binds, so wait for both ports as well.
    .withWaitStrategy(Wait.forAll([Wait.forListeningPorts(), Wait.forHttp('/readyz', API_PORT)]))
    .start();

  const api = `http://${container.getHost()}:${container.getMappedPort(API_PORT)}/api/v1`;

  async function messages(): Promise<CapturedMail[]> {
    const res = await fetch(`${api}/messages`);
    const page = (await res.json()) as { messages: CapturedMail[] };
    return page.messages;
  }

  return {
    smtpUrl: `smtp://${container.getHost()}:${container.getMappedPort(SMTP_PORT)}`,
    messages,
    // Auth mail is dispatched without being awaited, so a 2xx says nothing about delivery.
    async waitForMail(address: string, count = 1, timeoutMs = 30_000): Promise<CapturedMail[]> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const matching = (await messages()).filter((mail) => mail.To.some((to) => to.Address === address));
        if (matching.length >= count) return matching;
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} message(s) to ${address}; saw ${matching.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    async body(id: string): Promise<string> {
      const res = await fetch(`${api}/message/${id}`);
      return ((await res.json()) as { Text: string }).Text;
    },
    async clear(): Promise<void> {
      await fetch(`${api}/messages`, { method: 'DELETE' });
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}
