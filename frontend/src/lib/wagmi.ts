import { http, createConfig, type CreateConnectorFn } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { coinbaseWallet, injected, mock } from 'wagmi/connectors';
import { createClient } from 'viem';

const chains = [base, baseSepolia] as const;

const rpcOverride = import.meta.env.VITE_RPC_URL as string | undefined;

const connectors: CreateConnectorFn[] = [
  coinbaseWallet({
    appName: 'Assert',
  }),
  injected(),
];
if (import.meta.env.VITE_ENABLE_DEMO_WALLET === 'true') {
  connectors.push(mock({ accounts: [import.meta.env.VITE_DEMO_ADDRESS as `0x${string}`] }));
}

export const config = createConfig({
  chains,
  connectors,
  client({ chain }) {
    const url =
      rpcOverride ??
      (chain.id === base.id ? 'https://mainnet.base.org' : 'https://sepolia.base.org');
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