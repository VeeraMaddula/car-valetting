import { describe, expect, it } from 'vitest';
import { profileSchema } from '../src/domain/profile.js';

const required = { fullName: 'Mary Smith', email: ' Mary@Example.com ', phone: '087 123 4567' };

describe('profile details', () => {
  it('needs only name, email and phone; every other detail is optional', () => {
    const parsed = profileSchema.parse({ ...required, addressLine1: '', town: '  ', eircode: '' });
    expect(parsed).toMatchObject({ fullName: 'Mary Smith', email: 'mary@example.com', dateOfBirth: null, addressLine1: null, town: null, eircode: null });
    expect(profileSchema.safeParse({ ...required, fullName: 'M' }).success).toBe(false);
  });

  it('formats an Eircode and refuses one that cannot exist', () => {
    expect(profileSchema.parse({ ...required, eircode: 'x91h79y' }).eircode).toBe('X91 H79Y');
    expect(profileSchema.parse({ ...required, eircode: 'D6W 1234' }).eircode).toBe('D6W 1234');
    expect(profileSchema.safeParse({ ...required, eircode: 'B12 3456' }).success).toBe(false); // B isn't used
    expect(profileSchema.safeParse({ ...required, eircode: 'X91' }).success).toBe(false);
  });

  it('only accepts a real date of birth in the past', () => {
    expect(profileSchema.parse({ ...required, dateOfBirth: '1990-05-14' }).dateOfBirth).toBe('1990-05-14');
    expect(profileSchema.safeParse({ ...required, dateOfBirth: '1990-02-30' }).success).toBe(false);
    expect(profileSchema.safeParse({ ...required, dateOfBirth: '2999-01-01' }).success).toBe(false);
    expect(profileSchema.safeParse({ ...required, dateOfBirth: '1850-01-01' }).success).toBe(false);
  });
});
