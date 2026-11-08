import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpOtpSender } from '../src/modules/auth/otp-email';

/** OTP email over a real SMTP server (Mailpit, Testcontainers; needs Docker). */
let mailpit: StartedTestContainer;
let api = '';

beforeAll(async () => {
  mailpit = await new GenericContainer('axllent/mailpit:v1.27')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  api = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1`;
}, 120_000);
afterAll(() => mailpit?.stop());

describe('SmtpOtpSender over SMTP', () => {
  it('delivers the code to the inbox with the configured sender', async () => {
    const sender = SmtpOtpSender.fromUrl(`smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`, 'BD-LawAssist <no-reply@lawassist.test>');
    expect(await sender.send({ channel: 'EMAIL', to: 'rahim@example.com', code: '731905', language: 'BN' })).toBe('SENT');

    const list = (await (await fetch(`${api}/messages`)).json()) as { messages: { ID: string; Subject: string; From: { Address: string }; To: { Address: string }[] }[] };
    expect(list.messages).toHaveLength(1);
    const m = list.messages[0]!;
    expect(m).toMatchObject({ From: { Address: 'no-reply@lawassist.test' }, To: [{ Address: 'rahim@example.com' }] });
    expect(m.Subject).toContain('731905');
    const full = (await (await fetch(`${api}/message/${m.ID}`)).json()) as { Text: string };
    expect(full.Text).toContain('731905');
  });
});
