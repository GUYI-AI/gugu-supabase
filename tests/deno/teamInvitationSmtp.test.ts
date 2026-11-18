import nodemailer from 'npm:nodemailer@10.5.0';
import { teamInvitationMailer } from '../../supabase/functions/_shared/team-invitation-mailer.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function ownedServer(mode: 'plain' | 'implicit_tls' | 'starttls', loseFinalReply: boolean) {
  const directory = await Deno.makeTempDir({ prefix: 'team-smtp-loopback-' });
  await Deno.chmod(directory, 0o700);
  let ca = '';
  let child: Deno.ChildProcess;
  try {
    if (mode !== 'plain') {
      const openssl = async (args: string[]) => {
        const generated = await new Deno.Command('openssl', { args, stdout: 'null', stderr: 'piped' }).output();
        if (!generated.success) throw Error('Owned SMTP certificate generation failed');
      };
      await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', directory + '/ca-key.pem',
        '-out', directory + '/ca.pem', '-days', '1', '-subj', '/CN=Owned test root', '-addext', 'basicConstraints=critical,CA:TRUE']);
      await openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', directory + '/key.pem',
        '-out', directory + '/request.pem', '-subj', '/CN=localhost']);
      await Deno.writeTextFile(directory + '/extensions.conf', 'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
      await openssl(['x509', '-req', '-in', directory + '/request.pem', '-CA', directory + '/ca.pem', '-CAkey', directory + '/ca-key.pem',
        '-CAcreateserial', '-out', directory + '/cert.pem', '-days', '1', '-sha256', '-extfile', directory + '/extensions.conf']);
      await Deno.chmod(directory + '/key.pem', 0o600); await Deno.chmod(directory + '/ca-key.pem', 0o600);
      ca = await Deno.readTextFile(directory + '/ca.pem');
    }
    const fixture = new URL('../fixtures/team-smtp-loopback.py', import.meta.url).pathname;
    child = new Deno.Command('python3', { args: ['-u', fixture, directory, mode, String(loseFinalReply)], stdout: 'piped', stderr: 'piped' }).spawn();
  } catch (error) { await Deno.remove(directory, { recursive: true }); throw error; }
  const reader = child.stdout.getReader(), decoder = new TextDecoder(); let output = '';
  while (!output.includes('\n')) { const part = await reader.read(); if (part.done) throw Error('Owned SMTP peer did not start'); output += decoder.decode(part.value, { stream: true }); }
  const end = output.indexOf('\n'), ready = JSON.parse(output.slice(0, end)); output = output.slice(end + 1);
  if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw Error('Invalid loopback peer');
  let observation: Promise<{ connections: number; commands: string[]; bodies: string[] }> | undefined;
  const observe = () => observation ??= (async () => {
    for (;;) { const part = await reader.read(); if (part.done) break; output += decoder.decode(part.value, { stream: true }); }
    const [status, stderr] = await Promise.all([child.status, new Response(child.stderr).text()]);
    if (!status.success || stderr) throw Error('Owned SMTP peer failed');
    return JSON.parse(output.trim());
  })();
  return { port: ready.port, ca, observe, async close() { try { await observe(); } finally { reader.releaseLock(); await Deno.remove(directory, { recursive: true }); } } };
}
const message = () => ({ operationId: crypto.randomUUID(), invitationId: crypto.randomUUID(), to: 'recipient@example.invalid',
  teamName: 'Loopback team', invitationUrl: 'https://site.example.invalid/team/invite?region=cn#invitation_token=' + 'a'.repeat(64), expiresAt: '2099-11-20T00:00:00Z' });
function settings(port: number, mode: string): Record<string, string> {
  return { TEAM_INVITE_MAIL_ENABLED: 'true', TEAM_INVITE_SMTP_HOST: '127.0.0.1', TEAM_INVITE_SMTP_PORT: String(port),
    TEAM_INVITE_SMTP_USER: 'fixture', TEAM_INVITE_SMTP_PASSWORD: 'fixture', TEAM_INVITE_SMTP_FROM: 'sender@example.invalid',
    TEAM_INVITE_SMTP_TLS_MODE: mode, TEAM_INVITE_TEST_RECIPIENT: 'recipient@example.invalid' };
}
Deno.test('the real SMTP transport refuses AUTH and DATA when STARTTLS cannot be established', async () => {
  const server = await ownedServer('plain', false);
  try {
    const env = settings(server.port, 'starttls'), mailer = teamInvitationMailer(k => env[k]);
    equal((await mailer.send(message())).state, 'failed');
    const observed = await server.observe();
    equal(observed.connections, 1); equal(observed.commands.includes('EHLO'), true);
    equal(observed.commands.includes('AUTH'), false); equal(observed.bodies.length, 0);
  } finally { await server.close(); }
});
for (const [mode, lost] of [['implicit_tls', false], ['starttls', false], ['starttls', true]] as const) {
  Deno.test(`real ${mode}: ${lost ? 'lost final DATA reply remains unknown' : 'only explicit acceptance over verified TLS succeeds'}`, async () => {
    const server = await ownedServer(mode, lost);
    try {
      const env = settings(server.port, mode);
      // A test-only root CA trusts this owned leaf. Certificate checks stay on.
      const mailer = teamInvitationMailer(k => env[k], options => {
        equal(options.tls.rejectUnauthorized, true);
        return nodemailer.createTransport({ ...options, tls: { ...options.tls, ca: server.ca } });
      });
      const input = message(), result = await mailer.send(input), observed = await server.observe();
      equal(result.state, lost ? 'unknown' : 'accepted'); equal(observed.connections, 1); equal(observed.bodies.length, 1);
      equal(observed.bodies[0].includes('team-invitation-v1.' + input.invitationId), true);
      if (mode === 'starttls') equal(observed.commands.includes('STARTTLS'), true);
    } finally { await server.close(); }
  });
}
