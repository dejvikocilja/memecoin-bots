import { createHash } from 'node:crypto';

import type { MarketDiscoveryEvent } from '@memebots/core';

import { PROGRAMS } from './protocols.js';
import type { DiscoveryProgram } from './protocols.js';
import type { RpcInstruction, RpcTransaction } from './rpc.js';
import { isObject } from './rpc.js';
import schemas from './schemas.json' with { type: 'json' };
import type { LogNotification } from './transport.js';

export { PROGRAMS } from './protocols.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const byId = new Map(PROGRAMS.map((program) => [program.id, program]));
const eventCpiTag = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
const initialize = discriminator('global:initialize');
const initializeWithPermission = discriminator('global:initialize_with_permission');

type WireType =
  | string
  | { readonly defined: { readonly name: string } }
  | { readonly array: readonly [WireType, number] }
  | { readonly option: WireType };
interface WireStruct {
  readonly kind: 'struct';
  readonly fields: readonly { readonly name: string; readonly type: WireType }[];
}
interface WireEnum {
  readonly kind: 'enum';
  readonly variants: readonly { readonly name: string }[];
}
interface WireProgram {
  readonly programId: string;
  readonly events: readonly { readonly name: string; readonly discriminator: readonly number[] }[];
  readonly types: Readonly<Record<string, WireStruct | WireEnum>>;
}
const wirePrograms = schemas.programs as unknown as readonly WireProgram[];

/** Bounded, exact current-schema Borsh parsing. Unknown schema revisions fail closed. */
class Reader {
  offset = 0;
  constructor(
    readonly data: Buffer,
    readonly definitions: WireProgram['types'],
  ) {}
  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length)
      throw new Error('Truncated event');
    const result = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  read(type: WireType, depth = 0): unknown {
    if (depth > 16) throw new Error('Nested event exceeds limit');
    if (typeof type === 'string') {
      if (type === 'pubkey') return encodeBase58(this.take(32));
      if (type === 'string') {
        const length = this.take(4).readUInt32LE();
        if (length > 16_384) throw new Error('String exceeds limit');
        return new TextDecoder('utf-8', { fatal: true }).decode(this.take(length));
      }
      if (type === 'bool') {
        const value = this.take(1)[0];
        if (value !== 0 && value !== 1) throw new Error('Invalid boolean');
        return value === 1;
      }
      const size = { u8: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16 }[type];
      if (size === undefined) throw new Error('Unsupported primitive');
      const bytes = this.take(size);
      // Amounts/timestamps never pass through an imprecise JS number.
      let value = 0n;
      for (let index = bytes.length - 1; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[index]!);
      return value;
    }
    if ('array' in type) {
      const [element, length] = type.array;
      if (length > 1_024) throw new Error('Array exceeds limit');
      return Array.from({ length }, () => this.read(element, depth + 1));
    }
    if ('option' in type) {
      const tag = this.take(1)[0];
      if (tag !== 0 && tag !== 1) throw new Error('Invalid option');
      return tag === 0 ? null : this.read(type.option, depth + 1);
    }
    const definition = this.definitions[type.defined.name];
    if (!definition) throw new Error('Unknown event type');
    if (definition.kind === 'enum') {
      const variant = definition.variants[this.take(1)[0]!];
      if (!variant) throw new Error('Invalid enum');
      return variant.name;
    }
    return Object.fromEntries(
      definition.fields.map((field) => [field.name, this.read(field.type, depth + 1)]),
    );
  }
}

interface Invocation {
  readonly program: string;
  readonly depth: number;
  readonly parent: Invocation | undefined;
  readonly payloads: string[];
  readonly hints: string[];
  success: boolean | undefined;
}

/** Solana runtime lines cannot be forged by `msg!`, which adds `Program log: `. */
function invocations(logs: readonly string[]): readonly Invocation[] {
  const stack: Invocation[] = [];
  const calls: Invocation[] = [];
  for (const line of logs) {
    const start = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
    if (start) {
      const depth = Number(start[2]);
      if (depth !== stack.length + 1 || depth > 64) return [];
      const call: Invocation = {
        program: start[1]!,
        depth,
        parent: stack.at(-1),
        payloads: [],
        hints: [],
        success: undefined,
      };
      calls.push(call);
      stack.push(call);
      continue;
    }
    const end = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed: .*)$/.exec(line);
    if (end) {
      const call = stack.pop();
      if (!call || call.program !== end[1]) return [];
      call.success = end[2] === 'success';
      continue;
    }
    const call = stack.at(-1);
    if (!call) continue;
    if (line.startsWith('Program data: ')) call.payloads.push(line.slice(14));
    if (line.startsWith('Program log: Instruction: ')) call.hints.push(line.slice(26));
    if (line.startsWith('Program log: initialize2: ')) call.hints.push('initialize2');
  }
  // Truncated logs cannot prove that pending observations committed.
  if (stack.length) return [];
  return calls;
}
function committed(call: Invocation): boolean {
  return call.success === true && (call.parent === undefined || committed(call.parent));
}

/** HTTP enrichment is only scheduled for successful program-attributed creation hints. */
export function needsTransaction(logs: readonly string[]): boolean {
  return invocations(logs).some((call) => {
    const program = byId.get(call.program);
    if (
      !program ||
      !committed(call) ||
      !call.hints.some(
        (hint) =>
          program.initializationHints.includes(hint) ||
          (program.protocol === 'raydium-amm-v4' && hint === 'initialize2'),
      )
    )
      return false;
    // Most Pump launches already carry authoritative log events; avoid a request per launch.
    return !call.payloads.some(
      (payload) =>
        decodeEvent(Buffer.from(payload, 'base64'), program, {
          signature: '',
          slot: 0,
          logs: [],
        }) !== undefined,
    );
  });
}

export function decodeLogs(
  notification: LogNotification,
  onMalformed: () => void = () => {},
): MarketDiscoveryEvent[] {
  const events: MarketDiscoveryEvent[] = [];
  for (const call of invocations(notification.logs)) {
    if (!committed(call)) continue;
    const program = byId.get(call.program);
    if (!program) continue;
    for (const payload of call.payloads) {
      if (
        payload.length > 100_000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
      )
        continue;
      const event = decodeEvent(Buffer.from(payload, 'base64'), program, notification, onMalformed);
      if (event) events.push(event);
    }
  }
  return unique(events);
}

/** Both legacy and v0 keys, including lookup-table-loaded writable/readonly keys. */
export function decodeTransaction(
  transaction: RpcTransaction,
  notification: LogNotification,
  onMalformed: () => void = () => {},
): MarketDiscoveryEvent[] {
  try {
    if (transaction.meta.err !== null || transaction.slot !== notification.slot) return [];
    const { accountKeys, instructions } = transaction.transaction.message;
    const loaded = transaction.meta.loadedAddresses;
    const keys = [...accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
    if (
      keys.length > 256 ||
      !keys.every(validKey) ||
      !Array.isArray(instructions) ||
      instructions.length > 1_024
    )
      return [];
    const inner = transaction.meta.innerInstructions ?? [];
    if (!Array.isArray(inner) || inner.length > instructions.length) return [];
    const groups = new Map<number, readonly RpcInstruction[]>();
    for (const group of inner) {
      if (
        !Number.isSafeInteger(group.index) ||
        group.index < 0 ||
        group.index >= instructions.length ||
        groups.has(group.index) ||
        !Array.isArray(group.instructions) ||
        group.instructions.length > 10_000
      )
        return [];
      groups.set(group.index, group.instructions);
    }
    const ordered: readonly RpcInstruction[] = instructions.flatMap(
      (instruction: RpcInstruction, index: number) => [instruction, ...(groups.get(index) ?? [])],
    );
    const calls = invocations(transaction.meta.logMessages ?? notification.logs);
    const knownCalls = new Map<string, Invocation[]>();
    for (const call of calls)
      if (byId.has(call.program))
        knownCalls.set(call.program, [...(knownCalls.get(call.program) ?? []), call]);
    const counts = new Map<string, number>();
    for (const instruction of ordered) {
      if (!validInstruction(instruction, keys)) return [];
      const program = keys[instruction.programIdIndex]!;
      if (byId.has(program)) counts.set(program, (counts.get(program) ?? 0) + 1);
    }
    // Runtime execution order must match transaction instruction order. Ambiguity fails closed.
    for (const [program, count] of counts) if (knownCalls.get(program)?.length !== count) return [];
    const cursor = new Map<string, number>();
    const events: MarketDiscoveryEvent[] = [];
    for (const instruction of ordered) {
      const program = byId.get(keys[instruction.programIdIndex]!);
      if (!program) continue;
      const index = cursor.get(program.id) ?? 0;
      cursor.set(program.id, index + 1);
      const call = knownCalls.get(program.id)?.[index];
      if (
        !call ||
        !committed(call) ||
        (instruction.stackHeight != null && instruction.stackHeight !== call.depth)
      )
        continue;
      const data = decodeBase58(instruction.data);
      if (!data) continue;
      if (data.subarray(0, 8).equals(eventCpiTag)) {
        const event = decodeEvent(data.subarray(8), program, notification, onMalformed);
        if (event) events.push(event);
        continue;
      }
      const event = instructionPool(
        data,
        instruction.accounts.map((account) => keys[account]!),
        program,
        notification,
        onMalformed,
      );
      if (event) events.push(event);
    }
    return unique(events);
  } catch {
    return [];
  }
}

function validInstruction(instruction: RpcInstruction, keys: readonly string[]): boolean {
  return (
    isObject(instruction) &&
    Number.isSafeInteger(instruction.programIdIndex) &&
    instruction.programIdIndex >= 0 &&
    instruction.programIdIndex < keys.length &&
    typeof instruction.data === 'string' &&
    instruction.data.length <= 4_096 &&
    Array.isArray(instruction.accounts) &&
    instruction.accounts.length <= 256 &&
    instruction.accounts.every(
      (account: unknown) =>
        typeof account === 'number' &&
        Number.isSafeInteger(account) &&
        account >= 0 &&
        account < keys.length,
    )
  );
}

function decodeEvent(
  data: Buffer,
  program: DiscoveryProgram,
  notification: LogNotification,
  onMalformed: () => void = () => {},
): MarketDiscoveryEvent | undefined {
  const schema = wirePrograms.find((candidate) => candidate.programId === program.id);
  const event = schema?.events.find((candidate) =>
    data.subarray(0, 8).equals(Buffer.from(candidate.discriminator)),
  );
  if (!schema || !event) return undefined;
  try {
    const reader = new Reader(data.subarray(8), schema.types);
    const fields = reader.read({ defined: { name: event.name } });
    if (reader.offset !== reader.data.length || !isObject(fields))
      throw new Error('Invalid event length');
    const key = (name: string): string => {
      const value = fields[name];
      if (typeof value !== 'string' || !validKey(value)) throw new Error('Invalid event address');
      return value;
    };
    const common = {
      protocol: program.protocol,
      programId: program.id,
      signature: notification.signature,
      slot: notification.slot,
      observedAt: Date.now(),
      commitment: 'confirmed' as const,
      chain: 'solana' as const,
      source: event.name,
    };
    if (event.name === 'CreateEvent') {
      const mint = key('mint');
      return {
        ...common,
        id: identity(program.id, notification.signature, 'token-launched', mint),
        kind: 'token-launched',
        protocol: 'pump-fun',
        mint,
        bondingCurve: key('bonding_curve'),
        creator: key('creator'),
        quoteMint: key('quote_mint'),
      };
    }
    if (event.name === 'CompleteEvent') {
      const mint = key('mint');
      return {
        ...common,
        id: identity(program.id, notification.signature, 'bonding-curve-completed', mint),
        kind: 'bonding-curve-completed',
        protocol: 'pump-fun',
        mint,
        bondingCurve: key('bonding_curve'),
        quoteMint: key('quote_mint'),
      };
    }
    const names = {
      CreatePoolEvent: ['pool', 'base_mint', 'quote_mint'],
      PoolCreatedEvent: ['pool_state', 'token_mint_0', 'token_mint_1'],
      LbPairCreate: ['lb_pair', 'token_x', 'token_y'],
      EvtInitializePool: ['pool', 'token_a_mint', 'token_b_mint'],
      PoolCreated: ['pool', 'token_a_mint', 'token_b_mint'],
    }[event.name];
    if (!names) return undefined;
    const pool = key(names[0]!);
    return {
      ...common,
      id: identity(program.id, notification.signature, 'pool-created', pool),
      kind: 'pool-created',
      pool,
      mintA: key(names[1]!),
      mintB: key(names[2]!),
    };
  } catch {
    onMalformed();
    return undefined;
  }
}

function instructionPool(
  data: Buffer,
  accounts: readonly string[],
  program: DiscoveryProgram,
  notification: LogNotification,
  onMalformed: () => void,
): MarketDiscoveryEvent | undefined {
  let indexes: readonly [number, number, number];
  let source: string;
  if (
    program.protocol === 'raydium-cpmm' &&
    data.subarray(0, 8).equals(initialize) &&
    data.length === 32 &&
    accounts.length >= 20
  ) {
    indexes = [3, 4, 5];
    source = 'initialize';
  } else if (
    program.protocol === 'raydium-cpmm' &&
    data.subarray(0, 8).equals(initializeWithPermission) &&
    data.length === 33 &&
    data[32]! <= 2 &&
    accounts.length >= 21
  ) {
    indexes = [4, 5, 6];
    source = 'initialize_with_permission';
  } else if (
    program.protocol === 'raydium-amm-v4' &&
    data[0] === 1 &&
    data.length === 26 &&
    accounts.length >= 21
  ) {
    indexes = [4, 8, 9];
    source = 'Initialize2';
  } else {
    if (
      (program.protocol === 'raydium-cpmm' &&
        (data.subarray(0, 8).equals(initialize) ||
          data.subarray(0, 8).equals(initializeWithPermission))) ||
      (program.protocol === 'raydium-amm-v4' && data[0] === 1)
    )
      onMalformed();
    return undefined;
  }
  const [pool, mintA, mintB] = indexes.map((index) => accounts[index]!);
  if (!pool || !mintA || !mintB || mintA === mintB) return undefined;
  return {
    id: identity(program.id, notification.signature, 'pool-created', pool),
    kind: 'pool-created',
    protocol: program.protocol,
    programId: program.id,
    signature: notification.signature,
    slot: notification.slot,
    observedAt: Date.now(),
    commitment: 'confirmed',
    chain: 'solana',
    source,
    pool,
    mintA,
    mintB,
  };
}

function identity(program: string, signature: string, kind: string, entity: string): string {
  return `${program}:${signature}:${kind}:${entity}`;
}
function unique(events: readonly MarketDiscoveryEvent[]): MarketDiscoveryEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}
function discriminator(name: string): Buffer {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}
function validKey(value: unknown): value is string {
  return typeof value === 'string' && decodeBase58(value)?.length === 32;
}
function encodeBase58(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let text = '';
  while (value > 0n) {
    text = alphabet[Number(value % 58n)]! + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = '1' + text;
  }
  return text;
}
function decodeBase58(text: string): Buffer | undefined {
  if (!text.length || text.length > 4_096 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(text))
    return undefined;
  let value = 0n;
  for (const char of text) value = value * 58n + BigInt(alphabet.indexOf(char));
  const hex =
    value === 0n
      ? ''
      : value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, '0');
  const zeroes = text.length - text.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(zeroes), Buffer.from(hex, 'hex')]);
}
