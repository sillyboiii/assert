import { http, createConfig, type CreateConnectorFn } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { coinbaseWallet, injected, mock, walletConnect } from 'wagmi/connectors';
import { createClient, defineChain } from 'viem';

export const localAnvil = defineChain({
  id: 31337,
  name: 'Anvil Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://192.168.0.124:8545', 'http://localhost:8545', 'http://127.0.0.1:8545'] },
  },
});

const chains = [base, baseSepolia, localAnvil] as const;

const rpcOverride = import.meta.env.VITE_RPC_URL as string | undefined;

const connectors: CreateConnectorFn[] = [
  coinbaseWallet({
    appName: 'Assert',
    preference: { options: 'all' },
  }),
  injected(),
];
if (import.meta.env.VITE_WALLET_CONNECT_PROJECT_ID) {
  connectors.push(
    walletConnect({
      projectId: import.meta.env.VITE_WALLET_CONNECT_PROJECT_ID,
      showQrModal: true,
    }),
  );
}
if (import.meta.env.VITE_ENABLE_DEMO_WALLET === 'true') {
  connectors.push(mock({ accounts: [import.meta.env.VITE_DEMO_ADDRESS as `0x${string}`] }));
}

export const config = createConfig({
  chains,
  connectors,
  client({ chain }) {
    const url =
      rpcOverride ??
      (chain.id === base.id
        ? 'https://mainnet.base.org'
        : chain.id === localAnvil.id
          ? 'http://192.168.0.124:8545'
          : 'https://sepolia.base.org');
    return createClient({ chain, transport: http(url), batch: { multicall: true } });
  },
  ssr: false,
});

export const COMMITMENT_ADDRESS =
  (import.meta.env.VITE_COMMITMENT_ADDRESS as `0x${string}` | undefined) ??
  '0x0000000000000000000000000000000000000000';

export const COMMITMENT_V2_ADDRESS =
  (import.meta.env.VITE_COMMITMENT_V2_ADDRESS as `0x${string}` | undefined) ??
  '0x0000000000000000000000000000000000000000';

// Circle USDC on Base mainnet; override per deployment via VITE_USDC_ADDRESS.
export const USDC_ADDRESS =
  (import.meta.env.VITE_USDC_ADDRESS as `0x${string}` | undefined) ??
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const isBaseSepolia = (chainId?: number) => chainId === baseSepolia.id;

export const STATUS_LABEL: Record<number, string> = {
  0: 'Pending',
  1: 'Active',
  2: 'Approved',
  3: 'Failed',
  4: 'Cancelled',
};
