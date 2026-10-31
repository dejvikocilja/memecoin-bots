import { inspect } from 'node:util';

export const REDACTED = '[REDACTED]';

/** Explicit unwrapping is required at the provider/database boundary. */
export class Secret {
  #value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Secret must be a non-empty string');
    }
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Register every credential before validation or logging can produce an error. */
export class SecretRegistry {
  #variants = new Set<string>();
  #ordered: string[] = [];

  register(value: string): Secret {
    const secret = new Secret(value);
    // Cover common transport encodings. Arbitrary transformations of a secret
    // are outside this boundary; never use a hash/fragment as a log identifier.
    const encoded = encodeURIComponent(value);
    const variants = [
      value,
      encoded,
      encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      encodeURI(value),
      JSON.stringify(value).slice(1, -1),
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('base64url'),
    ];
    for (const variant of variants) this.#variants.add(variant);
    this.#ordered = [...this.#variants].sort((a, b) => b.length - a.length);
    return secret;
  }

  redact(text: string): string {
    let result = text;
    for (const value of this.#ordered) result = result.split(value).join(REDACTED);
    return result;
  }

  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}
