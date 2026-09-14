import { waitForTransactionReceipt } from 'wagmi/actions';
import { config } from './wagmi.ts';

type ConfigChainId = (typeof config.chains)[number]['id'];

export async function waitForTx(hash: `0x${string}`, chainId?: ConfigChainId): Promise<void> {
  await waitForTransactionReceipt(config, { hash, chainId, confirmations: 1 });
}
