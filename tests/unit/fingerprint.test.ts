import { describe, expect, it } from 'vitest';
import { fingerprintBaseKey, generateFingerprint, normalizeDescription } from '../../src/shared/utils/fingerprint';

const base = { accountId: 'acc-1', localDate: '2026-10-02', amount: '150.00', description: 'UPI-SWIGGY BANGALORE' };

describe('fingerprint', () => {
  it('ignores case, punctuation and spacing in descriptions', () => {
    expect(normalizeDescription('  UPI-Swiggy   (Bangalore)! ')).toBe('upi swiggy bangalore');
    expect(generateFingerprint({ ...base, description: 'upi swiggy  bangalore' })).toBe(generateFingerprint(base));
  });

  it('changes when any identifying field changes', () => {
    const f = generateFingerprint(base);
    expect(generateFingerprint({ ...base, accountId: 'acc-2' })).not.toBe(f);
    expect(generateFingerprint({ ...base, localDate: '2026-10-03' })).not.toBe(f);
    expect(generateFingerprint({ ...base, amount: '150.01' })).not.toBe(f);
    expect(generateFingerprint({ ...base, description: 'UPI-ZOMATO' })).not.toBe(f);
  });

  it('distinguishes the 1st and 2nd identical purchase via the occurrence ordinal', () => {
    // Two real coffees on the same day must not collapse into one.
    expect(generateFingerprint({ ...base, ordinal: 1 })).not.toBe(generateFingerprint({ ...base, ordinal: 2 }));
    expect(generateFingerprint({ ...base })).toBe(generateFingerprint({ ...base, ordinal: 1 }));
  });

  it('shares one base key across ordinals', () => {
    expect(fingerprintBaseKey(base)).toBe(fingerprintBaseKey({ ...base, description: 'upi swiggy bangalore' }));
  });
});
