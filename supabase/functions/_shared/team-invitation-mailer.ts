import { normalizedTeamEmail } from './team-accounts-contract.ts';
import type { InvitationMail, InvitationMailer } from './team-mail-flow.ts';

type Configuration = { host: string; port: number; user: string; password: string; from: string;
  mode: 'starttls' | 'implicit_tls' };
type Transport = { sendMail(message: Record<string, unknown>): Promise<any>; close(): void };
export type InvitationSmtpFactory = (options: Record<string, any>) => Promise<Transport> | Transport;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function mailbox(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Invalid mailbox');
  const address = normalizedTeamEmail(value);
  const [local, domain] = address.split('@');
  if (/[(),;:"\\\[\]*?]/.test(address) || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw Error('A single mailbox is required');
  return address;
}

function configuration(get: (name: string) => string | undefined): Configuration | null {
  if (get('TEAM_INVITE_MAIL_ENABLED') !== 'true') return null;
  try {
    const host = get('TEAM_INVITE_SMTP_HOST') ?? '', port = get('TEAM_INVITE_SMTP_PORT') ?? '';
    const user = get('TEAM_INVITE_SMTP_USER') ?? '', password = get('TEAM_INVITE_SMTP_PASSWORD') ?? '';
    const mode = get('TEAM_INVITE_SMTP_TLS_MODE');
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535
      || !user || user.length > 254 || /[\r\n\0]/.test(user) || !password || password.length > 4096
      || !['starttls', 'implicit_tls'].includes(mode ?? '')) return null;
    return { host, port: Number(port), user, password, mode: mode as Configuration['mode'],
      from: mailbox(get('TEAM_INVITE_SMTP_FROM')) };
  } catch { return null; }
}

export function invitationMessage(input: InvitationMail, from: string) {
  const to = mailbox(input.to), sender = mailbox(from);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.invitationId)
    || typeof input.teamName !== 'string' || input.teamName.length < 1 || input.teamName.length > 100 || /[\u0000-\u001f\u007f]/.test(input.teamName)) throw Error('Invalid invitation mail');
  const url = new URL(input.invitationUrl), fragment = new URLSearchParams(url.hash.slice(1));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/team/invite'
    || [...url.searchParams.keys()].length !== 1 || url.searchParams.get('region') === null || !['cn', 'hk'].includes(url.searchParams.get('region') ?? '')
    || [...fragment.keys()].length !== 1 || !/^[A-Za-z0-9_-]{43,256}$/.test(fragment.get('invitation_token') ?? '')) throw Error('Invalid invitation destination');
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw Error('Expired invitation mail');
  const expires = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(expiry);
  const title = '邀请你加入「' + input.teamName + '」';
  const text = title + '\n\n请打开邀请链接，使用被邀请的邮箱验证后加入团队：\n' + url.href
    + '\n\n链接有效至 ' + expires + '（北京时间）。\n如果你不认识这个团队，可以忽略此邮件。';
  const html = '<!doctype html><html lang="zh-CN"><body><h1>' + escapeHtml(title) + '</h1>'
    + '<p>请使用被邀请的邮箱完成验证后加入团队。</p><p><a href="' + escapeHtml(url.href) + '">查看团队邀请</a></p>'
    + '<p>链接有效至 ' + escapeHtml(expires) + '（北京时间）。</p><p>如果你不认识这个团队，可以忽略此邮件。</p></body></html>';
  return { from: { name: '咕咕', address: sender }, to, envelope: { from: sender, to: [to] }, subject: title, text, html,
    messageId: '<team-invitation-v1.' + input.invitationId.toLowerCase() + '@' + sender.split('@')[1] + '>',
    disableFileAccess: true, disableUrlAccess: true };
}

async function smtpFactory(options: Record<string, any>): Promise<Transport> {
  const library = await import('npm:nodemailer@10.5.0');
  return library.default.createTransport(options);
}
export function teamInvitationMailer(get: (name: string) => string | undefined, create: InvitationSmtpFactory = smtpFactory): InvitationMailer {
  const config = configuration(get);
  const enabled = get('TEAM_INVITE_MAIL_ENABLED') === 'true';
  let recipients: Set<string> | null = null;
  try {
    const raw = get('TEAM_INVITE_TEST_RECIPIENT');
    if (!raw || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) throw Error('Invalid recipient list');
    const entries = raw.split(',');
    if (entries.length > 100) throw Error('Invalid recipient list');
    recipients = new Set(entries.map(mailbox));
  } catch { /* Missing or malformed lists never mean unrestricted sending. */ }
  const recipientPolicy = (to: string): 'off' | 'allowed' | 'blocked' => {
    if (!enabled) return 'off';
    try { return recipients?.has(mailbox(to)) ? 'allowed' : 'blocked'; } catch { return 'blocked'; }
  };
  const canSend = (to: string) => {
    return config !== null && recipientPolicy(to) === 'allowed';
  };
  return {
    canSend, recipientPolicy,
    async send(input) {
      // The candidate uses an operator-approved existing test recipient. Never
      // redirect a different invitation to it or open SMTP without configuration.
      if (recipientPolicy(input.to) === 'blocked') return { state: 'failed', reason_code: 'recipient_not_allowed' };
      if (!config || !canSend(input.to)) return { state: 'failed', reason_code: 'smtp_rejected' };
      let transport: Transport | undefined, timeout: ReturnType<typeof setTimeout> | undefined, started = false;
      try {
        const message = invitationMessage(input, config.from);
        transport = await create({ host: config.host, port: config.port, secure: config.mode === 'implicit_tls',
          requireTLS: config.mode === 'starttls', authMethod: 'LOGIN', auth: { user: config.user, pass: config.password },
          tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, logger: false, debug: false, transactionLog: false,
          connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 5000,
          disableFileAccess: true, disableUrlAccess: true });
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('Mail result unknown')), 20000); });
        started = true;
        const result = await Promise.race([transport.sendMail(message), deadline]);
        if (!Array.isArray(result?.accepted) || result.accepted.length !== 1 || mailbox(result.accepted[0]) !== mailbox(input.to)
          || !Array.isArray(result.rejected) || result.rejected.length !== 0) return { state: 'unknown', reason_code: 'smtp_result_unknown' };
        return { state: 'accepted', reason_code: 'smtp_accepted' };
      } catch (error) {
        const e = error as { responseCode?: unknown };
        // ECONNECTION can also mean a lost reply after the complete DATA body.
        // Only a local pre-send failure or an explicit SMTP refusal is final.
        const rejected = !started || typeof e?.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 600;
        return rejected ? { state: 'failed', reason_code: 'smtp_rejected' } : { state: 'unknown', reason_code: 'smtp_result_unknown' };
      } finally { if (timeout) clearTimeout(timeout); transport?.close(); }
    },
  };
}
