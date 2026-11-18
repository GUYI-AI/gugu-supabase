import { describe, expect, it } from 'vitest';
import { trustedForwardedClientIp, trustedForwardedIpConfiguration } from '../../../supabase/functions/_shared/team-client-ip';

const config = { fromRight: 2, minimumItems: 2 };
const request = (headers: Record<string, string>) => new Request('https://edge.invalid/', { headers });

describe('optional trusted invitation IP selection', () => {
  it('stays off without both deployment settings', () => {
    expect(trustedForwardedIpConfiguration(() => undefined)).toBeNull();
    expect(trustedForwardedIpConfiguration(key => key.endsWith('FROM_RIGHT') ? '2' : undefined)).toBeNull();
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': '198.51.100.8, 172.18.0.1' }), null)).toBeNull();
  });
  it('uses the configured right-hand hop despite an attacker-supplied prefix', () => {
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': '203.0.113.99, 198.51.100.8, 172.18.0.1' }), config)).toBe('198.51.100.8');
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': 'untrusted-prefix, 198.51.100.8, 172.18.0.1' }), config)).toBe('198.51.100.8');
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': '198.51.100.8, 172.18.0.1' }), config)).toBe('198.51.100.8');
  });
  it('never falls back to X-Real-IP or a short forwarded chain', () => {
    expect(trustedForwardedClientIp(request({ 'x-real-ip': '198.51.100.8' }), config)).toBeNull();
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': '198.51.100.8', 'x-real-ip': '203.0.113.1' }), config)).toBeNull();
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': '198.51.100.8, 172.18.0.1' }), { fromRight: 2, minimumItems: 3 })).toBeNull();
  });
  it.each(['unknown', '', '198.51.100.8:1234', '[2001:db8::1]', 'fe80::1%eth0'])('ignores malformed selected value %s', selected => {
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': selected + ', 172.18.0.1' }), config)).toBeNull();
  });
  it('normalizes equivalent IPv6 values', () => {
    expect(trustedForwardedClientIp(request({ 'x-forwarded-for': '2001:0DB8:0000:0:0:0:0:0001, 172.18.0.1' }), config)).toBe('2001:db8::1');
  });
  it.each([['1', '2'], ['2', '1'], ['0', '2'], ['2', '33'], ['2x', '3'], ['2', '2.5']])('disables invalid configuration %s/%s', (position, minimum) => {
    expect(trustedForwardedIpConfiguration(key => key.endsWith('FROM_RIGHT') ? position : minimum)).toBeNull();
  });
});
