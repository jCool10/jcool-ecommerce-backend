import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const MAIL_IMAGE = 'axllent/mailpit:v1.31.1';
const SMTP_PORT = 1025;
const API_PORT = 8025;

// A port nothing listens on, so the connection is refused immediately — the same trick the search
// suites use, and safer than stopping the container under requests still in flight.
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

/**
 * Started per spec file rather than in globalSetup: only the mail suites need one, and every other
 * e2e file would otherwise wait on a container it never uses. Same for the search/storage helpers.
 */
export async function startMailServer(): Promise<StartedMailServer> {
  const container: StartedTestContainer = await new GenericContainer(MAIL_IMAGE)
    .withExposedPorts(SMTP_PORT, API_PORT)
    // Both ports, not just the HTTP probe: `/readyz` is served by the web server, so it answers
    // while the SMTP listener is still binding — and the first send would be the one that waits.
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
    // Registration dispatches its mail without awaiting it, so a 201 does not mean the message has
    // landed. Asserting straight after the response passes or fails by machine speed.
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
