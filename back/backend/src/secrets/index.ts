/** Thin seam so adapters depend on an interface, not raw env. Swap for a secrets manager later. */
export interface SecretStore {
  get(key: string): string | undefined;
  require(key: string): string;
}

export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  get(key: string): string | undefined {
    return this.env[key];
  }

  require(key: string): string {
    const v = this.env[key];
    if (v === undefined || v === "") throw new Error(`Missing required secret: ${key}`);
    return v;
  }
}
