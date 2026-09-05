import { waitForTransactionReceipt } from 'wagmi/actions';
import { config } from './wagmi.ts';

export async function waitForTx(hash: `0x${string}`): Promise<void> {
  await waitForTransactionReceipt(config, { hash, confirmations: 1 });
}