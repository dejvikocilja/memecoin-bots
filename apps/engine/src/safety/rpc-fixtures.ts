import { FIXTURE_MINT, fixtureAddress } from './fixtures.js';
import { TOKEN_PROGRAM } from './rpc.js';
export const SUPPLY = '10000000000000000000';
const account = (data: Buffer) => ({
  owner: TOKEN_PROGRAM,
  executable: false,
  data: [data.toString('base64'), 'base64'],
});
export function rpcFixture(method: string): unknown {
  const context = { slot: 100 };
  if (method === 'getAccountInfo') {
    const b = Buffer.alloc(82);
    b.writeBigUInt64LE(BigInt(SUPPLY), 36);
    b[44] = 9;
    b[45] = 1;
    return { context, value: account(b) };
  }
  if (method === 'getTokenSupply')
    return {
      context,
      value: { amount: SUPPLY, decimals: 9, uiAmount: null, uiAmountString: '10000000000' },
    };
  if (method === 'getTokenLargestAccounts')
    return {
      context,
      value: [2, 3].map((i) => ({
        address: fixtureAddress(i),
        amount: '600000000000000000',
        decimals: 9,
        uiAmount: null,
        uiAmountString: '600000000',
      })),
    };
  if (method === 'getMultipleAccounts')
    return {
      context,
      value: [2, 3].map(() => {
        const b = Buffer.alloc(165);
        Buffer.alloc(32, 1).copy(b);
        Buffer.alloc(32, 4).copy(b, 32);
        b.writeBigUInt64LE(600000000000000000n, 64);
        b[108] = 1;
        return account(b);
      }),
    };
  throw new Error('UNEXPECTED_METHOD');
}
export { FIXTURE_MINT };
