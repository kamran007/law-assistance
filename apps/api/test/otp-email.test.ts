import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { ChannelOtpSender, ConsoleOtpSender, type OtpMessage } from '../src/modules/auth/otp';
import { SmtpOtpSender, otpEmail } from '../src/modules/auth/otp-email';

/** OTP by email (SMTP) and channel routing. */
const email: OtpMessage = { channel: 'EMAIL', to: 'rahim@example.com', code: '482913', language: 'EN' };

describe('SmtpOtpSender', () => {
  it('builds a real message with nodemailer (JSON transport): code in subject and body, from / to set', async () => {
    const sent: { message: string }[] = [];
    const transport = createTransport({ jsonTransport: true });
    const spy = { sendMail: async (m: Parameters<typeof transport.sendMail>[0]) => {
      const info = await transport.sendMail(m);
      sent.push(info as unknown as { message: string });
      return info;
    } };
    expect(await new SmtpOtpSender(spy, 'BD-LawAssist <no-reply@example.com>').send(email)).toBe('SENT');
    const msg = JSON.parse(sent[0]!.message);
    expect(msg).toMatchObject({ to: [{ address: 'rahim@example.com' }], from: { address: 'no-reply@example.com', name: 'BD-LawAssist' }, subject: 'BD-LawAssist: your code is 482913' });
    expect(msg.text).toContain('482913');
    expect(msg.text).toContain('5 minutes');
  });

  it('Bangla message for BN users; refuses SMS', async () => {
    expect(otpEmail('482913', 'BN').text).toContain('482913');
    expect(otpEmail('482913', 'BN').subject).toMatch(/^বিডি-ল অ্যাসিস্ট/);
    await expect(new SmtpOtpSender({ sendMail: async () => ({}) as never }, 'x@y.z').send({ ...email, channel: 'SMS' })).rejects.toThrow();
  });

  it('a transport failure propagates (the API then answers 503 OTP_DELIVERY_FAILED)', async () => {
    const failing = new SmtpOtpSender({ sendMail: async () => Promise.reject(new Error('535 auth failed')) }, 'x@y.z');
    await expect(failing.send(email)).rejects.toThrow('535');
  });
});

describe('ChannelOtpSender', () => {
  it('routes by channel and fails a channel without a sender', async () => {
    const mails: string[] = [];
    const s = new ChannelOtpSender({ EMAIL: { send: async (m) => void mails.push(m.to) }, SMS: new ConsoleOtpSender(() => undefined) });
    expect(await s.send(email)).toBeUndefined(); // = SENT
    expect(await s.send({ ...email, channel: 'SMS', to: '+8801711000000' })).toBe('DEV_CONSOLE');
    expect(mails).toEqual(['rahim@example.com']);
    await expect(new ChannelOtpSender({ EMAIL: new ConsoleOtpSender(() => undefined) }).send({ ...email, channel: 'SMS' })).rejects.toThrow(/No SMS sender/);
  });
});
