/** Password hashing and verification for the login feature. */
export function hashPassword(password: string): string {
  // pretend hash
  return `hashed:${password}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}
