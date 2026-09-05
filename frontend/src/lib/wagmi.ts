import { http, createConfig } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { coinbaseWallet, injected } from 'wagmi/connectors';
import { createClient } from 'viem';

const chains = [base, baseSepolia] as const;

export const config = createConfig({
  chains,
  connectors: [
    coinbaseWallet({
      appName: 'Assert',
    }),
    injected(),
  ],
  client({ chain }) {
    const url = chain.id === base.id ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
    return createClient({ chain, transport: http(url), batch: { multicall: true } });
  },
  ssr: false,
});

export const COMMITMENT_ADDRESS =
  (import.meta.env.VITE_COMMITMENT_ADDRESS as `0x${string}` | undefined) ??
  '0x0000000000000000000000000000000000000000';

export const isBaseSepolia = (chainId?: number) => chainId === baseSepolia.id;

export const STATUS_LABEL: Record<number, string> = {
  0: 'Pending',
  1: 'Active',
  2: 'Approved',
  3: 'Failed',
  4: 'Cancelled',
};