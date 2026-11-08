import { createTransport, type Transporter } from 'nodemailer';
import type { OtpDelivery, OtpMessage, OtpSender } from './otp';
import { OTP_POLICY } from './otp';

/**
 * One-time codes by email over SMTP (any provider: Gmail with an app password, Amazon SES SMTP,
 * Brevo, Mailgun …). The code appears only in the message, never in logs.
 */
export class SmtpOtpSender implements OtpSender {
  constructor(
    private readonly transport: Pick<Transporter, 'sendMail'>,
    private readonly from: string,
  ) {}

  /** `SMTP_URL` e.g. `smtps://user:app-password@smtp.gmail.com:465`. */
  static fromUrl(url: string, from: string): SmtpOtpSender {
    return new SmtpOtpSender(createTransport(url), from);
  }

  async send(msg: OtpMessage): Promise<OtpDelivery> {
    if (msg.channel !== 'EMAIL') throw new Error('SmtpOtpSender only sends email');
    const m = otpEmail(msg.code, msg.language);
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: m.subject, text: m.text, html: m.html });
    return 'SENT';
  }
}

const MINUTES = OTP_POLICY.ttlSeconds / 60;

/** Plain, short, bilingual-safe message; the code is the only variable part. */
export function otpEmail(code: string, language: 'BN' | 'EN'): { subject: string; text: string; html: string } {
  const t =
    language === 'BN'
      ? {
          subject: `বিডি-ল অ্যাসিস্ট: আপনার কোড ${code}`,
          lead: 'সাইন ইন করতে এই কোডটি ব্যবহার করুন:',
          expiry: `কোডটি ${MINUTES} মিনিট পর্যন্ত কার্যকর। কাউকে এই কোড জানাবেন না; আমরা কখনো কোড চাই না।`,
          ignore: 'আপনি সাইন ইন করার চেষ্টা না করে থাকলে এই ইমেইলটি উপেক্ষা করুন।',
        }
      : {
          subject: `BD-LawAssist: your code is ${code}`,
          lead: 'Use this code to sign in:',
          expiry: `It is valid for ${MINUTES} minutes. Never share it with anyone; we will never ask you for it.`,
          ignore: "If you didn't try to sign in, you can ignore this email.",
        };
  const text = `${t.lead}\n\n${code}\n\n${t.expiry}\n${t.ignore}\n`;
  const html = `<p>${t.lead}</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>${t.expiry}</p><p style="color:#666">${t.ignore}</p>`;
  return { subject: t.subject, text, html };
}
