import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { HttpError } from '../utils';

type S = string | null | undefined;
export interface Sender { name?: S; email?: S; companyName?: S; postalAddress?: S; website?: S; signature?: S }

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function unsubscribeUrl(token: string) {
  return `${env.API_URL.replace(/\/$/, '')}/u/${token}`;
}

/**
 * Build the final compliant message. Footer (identity, address, unsubscribe) is always added
 * by the platform — never by AI — so it can't be omitted.
 */
const REASONS: Record<string, string> = {
  express_consent: 'You received this email because you agreed to be contacted by us.',
  legitimate_interest: 'You received this one-off business email because your business contact details are publicly listed and our services may be relevant to you.'
};
const DEFAULT_REASON = 'You received this one-off business email because your contact details are publicly listed for your business.';

export function renderEmail(opts: { body: string; sender: Sender; unsubscribeToken: string; trackingId: string; trackOpens?: boolean; basis?: string | null }) {
  const unsub = unsubscribeUrl(opts.unsubscribeToken);
  const s = opts.sender;
  const sig = s.signature?.trim() || [s.name, s.companyName].filter(Boolean).join('\n');
  const footer = [
    `${s.companyName || s.name}${s.postalAddress ? `, ${s.postalAddress}` : ''}`,
    REASONS[opts.basis || ''] || DEFAULT_REASON,
    `Don't want to hear from us? Unsubscribe: ${unsub}`
  ].join('\n');

  const text = `${opts.body.trim()}\n\n${sig}\n\n--\n${footer}`;
  const pixel = opts.trackOpens === false ? '' : `<img src="${env.API_URL}/t/o/${opts.trackingId}.gif" width="1" height="1" alt="" style="display:none">`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2937">
${escapeHtml(opts.body.trim()).replace(/\n/g, '<br>')}
<br><br>${escapeHtml(sig).replace(/\n/g, '<br>')}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0 10px">
<div style="font-size:11px;color:#6b7280">${footer.split('\n').slice(0, 2).map(escapeHtml).join('<br>')}<br>
<a href="${unsub}" style="color:#6b7280">Unsubscribe</a></div>${pixel}</div>`;

  return {
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

/** Direct-mode sending via SMTP (e.g. Google Workspace SMTP relay or Gmail app password). */
export async function sendSmtp(msg: { from: string; to: string; subject: string; text: string; html: string; headers: Record<string, string> }) {
  const url = process.env.SMTP_URL;
  if (!url) throw new HttpError(503, 'SMTP_URL is not configured for direct sending.', 'smtp_not_configured');
  const transport = nodemailer.createTransport(url);
  const info = await transport.sendMail(msg);
  return info.messageId as string;
}
