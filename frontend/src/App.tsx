import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, getAbiItem, getAddress, http, parseAbi, parseUnits, formatEther, formatUnits } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSignMessage,
  useSwitchChain,
  useWriteContract,
  type Connector,
} from 'wagmi';
import { commitmentAbi } from './Commitment.abi.ts';
import { COMMITMENT_ADDRESS, COMMITMENT_V2_ADDRESS, USDC_ADDRESS, STATUS_LABEL, localAnvil } from './lib/wagmi.ts';
import { waitForTx } from './lib/tx.ts';
import { clearAuthToken, ensureAuthToken, mintAuthToken, setMintHook } from './lib/auth.ts';
import {
  readStoredPreferences,
  readRefereeDenials,
  readStoredProfile,
  readStoredProfiles,
  saveRefereeDenial,
  saveStoredPreferences,
  saveStoredProfile,
  hasSupabase,
  type StoredRefereeDenial,
} from './lib/supabase.ts';

type GoalStruct = [
  creator: `0x${string}`,
  referee: `0x${string}`,
  goalText: string,
  amount: bigint,
  fee: bigint,
  deadline: bigint,
  status: number,
];

type GoalSource = 'v1' | 'v2';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const goalKey = (id: bigint | string, source: GoalSource) => (source === 'v2' ? `v2-${id}` : `${id}`);
const splitGoalKey = (key: string): { source: GoalSource; id: bigint } => {
  if (key.startsWith('v2-')) return { source: 'v2', id: BigInt(key.slice(3)) };
  return { source: 'v1', id: BigInt(key) };
};
const fmtAmount = (w: bigint, source: GoalSource, decimals = 2) =>
  (Number(formatUnits(w, source === 'v2' ? 6 : 18))).toFixed(source === 'v2' ? decimals : 3).replace(/\.?0+$/, '');
const unitOf = (source: GoalSource) => (source === 'v2' ? 'USDC' : 'ETH');

type CreatedArgs = {
  id: bigint;
  source: GoalSource;
  creator: `0x${string}`;
  referee: `0x${string}`;
  goalText: string;
  amount: bigint;
  deadline: bigint;
};

type UserProfile = {
  username: string;
  pfpUrl: string;
  locked: boolean;
};

type Friend = {
  name: string;
  role: string;
  record: string;
  detail: string;
  pfp: string;
  address: `0x${string}`;
};

type StakeCurrency = 'ETH' | 'USDC';

const short = (a: `0x${string}` | undefined, n = 4) =>
  a ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : '';
const profileName = (
  addr: `0x${string}` | undefined,
  profiles: Record<string, UserProfile> = {},
) => (addr ? (profiles[addr] ?? profiles[addr.toLowerCase()])?.username || short(addr, 4) : '');
const FEE_BPS = 200n; // 2% protocol fee, mirrors the live contract
const ACCEPT_ROLE_GAS = 120_000n;
const LOCAL_COMMITMENT_V2_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const LOCAL_USDC_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PROFILE_STORAGE_KEY = 'assert-profiles-v1';
const MOCK_ADDRESS = '0xA45DE27583345d4A1357220d5FDaBE9140Ce6157' as const;
const MOCK_REFEREE = '0x2d17E0dbcf32709A964a28074efa9528df71DEa4' as const;

const commitmentV2Abi = parseAbi([
  'function nextId() view returns (uint256)',
  'function createGoalWithToken(string goalText, address referee, uint256 deadline, address token, uint256 amount) returns (uint256)',
  'function goals(uint256) view returns (address creator, address referee, address token, string goalText, uint256 amount, uint256 feeAmount, uint256 deadline, uint8 status)',
  'function acceptRole(uint256 id)',
  'function approve(uint256 id)',
  'function claimReferee(uint256 id)',
  'function forfeit(uint256 id)',
  'function refundNoShow(uint256 id)',
  'function cancel(uint256 id)',
  'event Created(uint256 indexed id, address indexed creator, address indexed referee, address token, string goalText, uint256 amount, uint256 deadline)',
]);

type GoalStructV2 = [
  creator: `0x${string}`,
  referee: `0x${string}`,
  token: `0x${string}`,
  goalText: string,
  amount: bigint,
  fee: bigint,
  deadline: bigint,
  status: number,
];

// V2's struct has token inserted at index 2; fold it back into the V1 GoalStruct shape.
const v2ToGoalStruct = (raw: GoalStructV2): GoalStruct => [raw[0], raw[1], raw[3], raw[4], raw[5], raw[6], raw[7]];

const erc20TestAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);

const MOCK_GOALS: CreatedArgs[] = [
  {
    id: 9001n,
    source: 'v1',
    creator: MOCK_ADDRESS,
    referee: MOCK_REFEREE,
    goalText: 'wake up before 7am every day for 21 days\n\nProof standard: morning check-in message',
    amount: parseUnits('0.001', 18),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 21 * 86400),
  },
  {
    id: 9002n,
    source: 'v1',
    creator: MOCK_ADDRESS,
    referee: MOCK_REFEREE,
    goalText: 'ship one meaningful product update this week\n\nProof standard: live link and public changelog',
    amount: parseUnits('0.005', 18),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 86400),
  },
  {
    id: 9003n,
    source: 'v2',
    creator: MOCK_ADDRESS,
    referee: MOCK_REFEREE,
    goalText: 'save $100 before next friday\n\nProof standard: savings screenshot every friday',
    amount: parseUnits('100', 6),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 86400),
  },
];

function toGoalStruct(goal: CreatedArgs, status = 1): GoalStruct {
  return [
    goal.creator,
    goal.referee,
    goal.goalText,
    goal.amount,
    (goal.amount * FEE_BPS) / 10_000n,
    goal.deadline,
    status,
  ];
}

function assertUrl(id: bigint | string, source: GoalSource) {
  return `${window.location.origin}/g/${goalKey(id, source)}?v=template-restored`;
}

function readDeepLinkedGoal() {
  const hash = window.location.hash.match(/^#g\/(v2-)?(\d+)$/);
  if (hash) return hash[1] ? `${hash[1]}${hash[2]}` : hash[2];
  const path = window.location.pathname.match(/^\/g\/(v2-)?(\d+)$/);
  if (path) return path[1] ? `${path[1]}${path[2]}` : path[2];
  return null;
}

function assertShareHref({ id, title, amount, status, source }: { id: bigint | string; title: string; amount: bigint; status: number; source: GoalSource }) {
  const unit = unitOf(source);
  const line = status === 2
    ? `I kept my word on Assert: "${title}".`
    : status === 1
      ? `I put ${fmtAmount(amount, source, 3)} ${unit} on this assert: "${title}".`
      : status === 0
        ? `I just made an assert: "${title}".`
        : `I put my word onchain with Assert: "${title}".`;
  const text = `${line}\n\nNo streaks. No badges. Real accountability.`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(assertUrl(id, source))}`;
}

function XLogo() {
  return (
    <svg className="x-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M18.9 2.9h3.3l-7.3 8.3 8.6 11.4h-6.7l-5.3-6.9-6 6.9H2.2l7.8-8.9L1.7 2.9h6.9l4.7 6.3 5.6-6.3Zm-1.2 17.7h1.8L7.6 4.8h-2l12.1 15.8Z" />
    </svg>
  );
}

function ShareOnXLabel() {
  return (
    <>
      share on <XLogo />
    </>
  );
}

function defaultProfile(address?: `0x${string}`): UserProfile {
  return { username: address ? short(address, 3) : 'you', pfpUrl: '', locked: false };
}

function readProfiles() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) ?? '{}') as Record<string, UserProfile>;
  } catch {
    return {};
  }
}

function readStringList(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
  } catch {
    return [];
  }
}

const FOLLOWED_KEY = (address: string) => `assert-followed-goals:${address.toLowerCase()}`;

function readFollowed(address: string): string[] {
  return readStringList(FOLLOWED_KEY(address));
}

function ProfileAvatar({ profile, fallback = 'Y' }: { profile: UserProfile; fallback?: string }) {
  const initial = (profile.username || fallback).trim().slice(0, 1).toUpperCase() || fallback;
  return profile.pfpUrl.trim() ? (
    <img className="profile-avatar" src={profile.pfpUrl.trim()} alt={`${profile.username || 'your'} pfp`} />
  ) : (
    <div className="profile-avatar">{initial}</div>
  );
}

function MiniAvatar({ name, src }: { name: string; src?: string }) {
  const initial = name.trim().slice(0, 1).toUpperCase() || 'A';
  return src?.trim() ? (
    <img className="mini-avatar" src={src.trim()} alt={`${name} pfp`} />
  ) : (
    <span className="mini-avatar">{initial}</span>
  );
}

function useCountdown(deadline: bigint | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = deadline ? Number(deadline) * 1000 - now : 0;
  const urgent = ms > 0 && ms < 24 * 3600 * 1000;
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const out = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { out, urgent, expired: ms <= 0 };
}

function useEthPriceUsd(): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!cancelled && d?.ethereum?.usd != null) setPrice(Number(d.ethereum.usd));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return price;
}

const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http('https://eth.llamarpc.com', { timeout: 8000 }),
});

function walletMeta(id?: string): { name: string; initial: string; color: string } {
  switch (id) {
    case 'coinbaseWalletSDK':
      return { name: 'Coinbase Wallet', initial: 'C', color: '#0052FF' };
    case 'walletConnect':
      return { name: 'WalletConnect', initial: 'W', color: '#3B99FC' };
    case 'injected':
      return { name: 'Browser wallet', initial: '⬡', color: 'var(--indigo)' };
    case 'mock':
      return { name: 'Demo wallet', initial: 'D', color: 'var(--blue)' };
    case 'io.metamask':
      return { name: 'MetaMask', initial: 'M', color: '#F6851B' };
    case 'io.rabby':
      return { name: 'Rabby', initial: 'R', color: '#8B5CF6' };
    case 'app.phantom':
      return { name: 'Phantom', initial: 'P', color: '#AB9FF2' };
    case 'com.brave.wallet':
      return { name: 'Brave Wallet', initial: 'B', color: '#FB542B' };
    case 'com.coinbase.wallet':
      return { name: 'Coinbase Wallet', initial: 'C', color: '#0052FF' };
    default: {
      if (id && !id.includes('.')) return { name: id, initial: '•', color: 'var(--muted)' };
      const last = (id ?? '').split('.').pop() ?? '';
      const name = last ? last[0]!.toUpperCase() + last.slice(1) : 'Wallet';
      return { name, initial: name[0] ?? '•', color: 'var(--muted)' };
    }
  }
}

const LOGO_SRC: Record<string, string> = {
  coinbaseWalletSDK: '/wallets/coinbase.svg',
  'com.coinbase.wallet': '/wallets/coinbase.svg',
  walletConnect: '/wallets/walletconnect.svg',
};

function WalletLogo({ connector }: { connector: Connector }) {
  const src = connector.icon || LOGO_SRC[connector.id];
  if (!src) return null;
  return <img className="wallet-img" src={src} alt="" />;
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const { connect, connectors, isPending } = useConnect();
  const [browserOpen, setBrowserOpen] = useState(false);
  const detected = connectors.filter((c) => c.type === 'injected' && c.id !== 'injected');
  const used = detected.length > 0 ? detected : connectors.filter((c) => c.type === 'injected');
  const pinned = connectors.filter((c) => c.type !== 'injected');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="choose a wallet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>connect a wallet</h2>
          <button className="modal-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        <p className="modal-sub muted">
          your keys stay in your wallet. we only read your address and ask you to approve payments — nothing else.
        </p>
        <div className="wallet-list">
          {used.length > 0 && (
            <div className="browser-group">
              <button
                className="wallet-row"
                onClick={() => setBrowserOpen((v) => !v)}
                disabled={isPending}
                aria-expanded={browserOpen}
              >
                <span className="wallet-ico" style={{ background: 'var(--indigo)' }}>
                  ⬡
                </span>
                <span className="wallet-name">Browser wallet</span>
                <span className="wallet-cta">{browserOpen ? '▴' : '▾'}</span>
              </button>
              {browserOpen && (
                <div className="browser-sub">
                  {used.map((c) => {
                    const meta = walletMeta(c.id);
                    return (
                      <button
                        key={c.uid}
                        className="wallet-row wallet-sub"
                        onClick={() => connect({ connector: c })}
                        disabled={isPending}
                      >
                        <WalletLogo connector={c} />
                        {!c.icon && !LOGO_SRC[c.id] && (
                          <span className="wallet-ico" style={{ background: meta.color }}>
                            {meta.initial}
                          </span>
                        )}
                        <span className="wallet-name">{meta.name}</span>
                        <span className="wallet-cta">{isPending ? 'connecting…' : '→'}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {pinned.map((c) => {
            const meta = walletMeta(c.id);
            return (
              <button key={c.uid} className="wallet-row" onClick={() => connect({ connector: c })} disabled={isPending}>
                <WalletLogo connector={c} />
                {!c.icon && !LOGO_SRC[c.id] && (
                  <span className="wallet-ico" style={{ background: meta.color }}>
                    {meta.initial}
                  </span>
                )}
                <span className="wallet-name">{meta.name}</span>
                <span className="wallet-cta">{isPending ? 'connecting…' : '→'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ConnectButton({ label = 'Connect wallet' }: { label?: string }) {
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  if (isConnected) {
    return (
      <button className="chip" onClick={() => disconnect()}>
        {short(address)} · disconnect
      </button>
    );
  }
  return (
    <div className="conn-row">
      <button className="btn-primary" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && createPortal(<ConnectModal onClose={() => setOpen(false)} />, document.body)}
    </div>
  );
}

/* ---------------- data hook: all created goals ---------------- */

function useGoalsByIds(goals: CreatedArgs[]) {
  const v1Idx = goals.map((g) => (g.source === 'v1' ? g.id : undefined)).filter((x): x is bigint => x !== undefined);
  const v2Idx = goals.map((g) => (g.source === 'v2' ? g.id : undefined)).filter((x): x is bigint => x !== undefined);
  const v1 = useReadContracts({
    chainId: base.id,
    contracts: v1Idx.map((id) => ({
      address: COMMITMENT_ADDRESS,
      abi: commitmentAbi,
      functionName: 'goals' as const,
      args: [id],
    })),
  });
  const v2 = useReadContracts({
    chainId: base.id,
    contracts: v2Idx.map((id) => ({
      address: COMMITMENT_V2_ADDRESS,
      abi: commitmentV2Abi,
      functionName: 'goals' as const,
      args: [id],
    })),
  });
  const v1Data = v1.data ?? [];
  const v2Data = v2.data ?? [];
  return goals.map((g) => {
    if (g.source === 'v2') {
      const i = v2Idx.indexOf(g.id);
      const isDeployed = COMMITMENT_V2_ADDRESS !== ZERO_ADDRESS;
      if (!isDeployed) return toGoalStruct(g);
      const r = v2Data[i];
      if (!r || r.status !== 'success') return toGoalStruct(g);
      return v2ToGoalStruct(r.result as GoalStructV2);
    }
    const i = v1Idx.indexOf(g.id);
    const r = v1Data[i];
    if (!r || r.status !== 'success') return toGoalStruct(g);
    return r.result as GoalStruct;
  });
}

function useAllCreated() {
  const publicClient = usePublicClient({ chainId: base.id });
  const chainId = publicClient?.chain.id;
  const v2Deployed = COMMITMENT_V2_ADDRESS !== ZERO_ADDRESS;
  return useQuery({
    queryKey: ['allCreated', chainId, v2Deployed],
    queryFn: async () => {
      if (!publicClient) return [];
      const nextId = await publicClient.readContract({
        address: COMMITMENT_ADDRESS,
        abi: commitmentAbi,
        functionName: 'nextId',
      }) as bigint;
      const total = Number(nextId);
      const readGoals = async (
        address: `0x${string}`,
        abi: typeof commitmentAbi | typeof commitmentV2Abi,
        count: number,
        call: (r: { status: string; result: unknown }, id: number) => CreatedArgs | undefined,
      ): Promise<CreatedArgs[]> => {
        if (!count) return [];
        const results = await publicClient.multicall({
          allowFailure: true,
          contracts: Array.from({ length: count }, (_, id) => ({
            address,
            abi,
            functionName: 'goals' as const,
            args: [BigInt(id)],
          })),
        });
        return results
          .map((r, id) => (r.status === 'success' ? call(r, id) : undefined))
          .filter((g): g is CreatedArgs => Boolean(g));
      };
      const v1 = await readGoals(COMMITMENT_ADDRESS, commitmentAbi, total, (r, id) => {
        const [creator, referee, goalText, amount, , deadline] = r.result as GoalStruct;
        return { id: BigInt(id), source: 'v1', creator, referee, goalText, amount, deadline };
      });
      let v2: CreatedArgs[] = [];
      if (v2Deployed) {
        const v2Total = Number(await publicClient.readContract({
          address: COMMITMENT_V2_ADDRESS,
          abi: commitmentV2Abi,
          functionName: 'nextId',
        }) as bigint);
        v2 = await readGoals(COMMITMENT_V2_ADDRESS, commitmentV2Abi, v2Total, (r, id) => {
          const [creator, referee, , goalText, amount, , deadline] = r.result as GoalStructV2;
          return { id: BigInt(id), source: 'v2', creator, referee, goalText, amount, deadline };
        });
      }
      return v2
        .concat(v1)
        .sort((a, b) => (a.source === b.source ? (a.id < b.id ? 1 : -1) : a.source < b.source ? 1 : -1));
    },
    refetchInterval: 20_000,
  });
}

/* ---------------- wizard ---------------- */

const ASSERT_TEMPLATES = [
  { label: 'body', goal: 'train 4x a week for 30 days', proof: 'send gym check-in photos or workout logs every week' },
  { label: 'focus', goal: 'no doomscrolling before noon for 14 days', proof: 'share screen time screenshots every night' },
  { label: 'ship', goal: 'ship my project by friday', proof: 'send the live link and public changelog to my referee' },
  { label: 'discipline', goal: 'wake up before 7am every day for 21 days', proof: 'send a timestamped morning photo each day' },
];

function Step1Goal({
  goal,
  setGoal,
  proof,
  setProof,
}: {
  goal: string;
  setGoal: (v: string) => void;
  proof: string;
  setProof: (v: string) => void;
}) {
  return (
    <div className="fade-up-1">
      <div className="builder-copy">
        <span className="eyebrow">the promise</span>
        <h3>what are you putting on the line?</h3>
      </div>
      <div className="textarea-shell goal-shell">
        <textarea
          className="goal-input"
          name="goal"
          maxLength={280}
          rows={3}
          placeholder="train 4x a week for 30 days…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          autoFocus
        />
        <span className="char-count">{goal.length}/280</span>
      </div>
      <div className="template-row">
        {ASSERT_TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            className="template-chip"
            onClick={() => {
              setGoal(t.goal);
              if (!proof.trim()) setProof(t.proof);
            }}
          >
            <span>{t.label}</span>
            <b>→</b>
          </button>
        ))}
      </div>
    </div>
  );
}

function Step2Referee({
  value,
  onChange,
  onResolved,
  friends,
  proof,
  setProof,
}: {
  value: string;
  onChange: (v: string) => void;
  onResolved: (addr: `0x${string}` | null) => void;
  friends: Friend[];
  proof: string;
  setProof: (v: string) => void;
}) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pickFriends, setPickFriends] = useState(true);

  useEffect(() => {
    let alive = true;
    const raw = value.trim();
    setResolved(null);
    onResolved(null);
    if (raw.endsWith('.eth') && raw.length > 4) {
      setResolving(true);
      mainnetClient
        .getEnsAddress({ name: raw as `${string}.eth` })
        .then((addr) => {
          if (!alive) return;
          setResolved(addr ?? null);
          onResolved((addr ?? null) as `0x${string}` | null);
        })
        .catch(() => {
          if (alive) onResolved(null);
        })
        .finally(() => {
          if (alive) setResolving(false);
        });
    }
    return () => {
      alive = false;
    };
  }, [value]);

  let valid = false;
  let addr: `0x${string}` | undefined;
  if (resolved) {
    valid = true;
    addr = resolved as `0x${string}`;
  } else {
    const t = value.trim();
    if (t.startsWith('0x')) {
      try {
        addr = getAddress(t) as `0x${string}`;
        valid = true;
      } catch {
        valid = false;
      }
    }
  }

  return (
    <div className="fade-up-1">
      <div className="builder-copy">
        <span className="eyebrow">accountability</span>
        <h3>who’s holding you to it?</h3>
        <p className="muted">they call the shots on your proof. pick a friend who won’t let you slide.</p>
      </div>
      {pickFriends ? (
        friends.length > 0 ? (
          <div className="friend-choice-list">
            {friends.map((friend) => {
              const isOn = friend.address.toLowerCase() === value.trim().toLowerCase();
              return (
                <button
                  key={friend.address}
                  type="button"
                  className={`friend-choice${isOn ? ' on' : ''}`}
                  onClick={() => {
                    onChange(friend.address);
                    onResolved(friend.address);
                  }}
                >
                  <MiniAvatar name={friend.name} src={friend.pfp} />
                  <span className="friend-choice-body">
                    <b>{friend.name}</b>
                    <small>{friend.role}</small>
                  </span>
                  {isOn ? <i>✓</i> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="empty-copy">no friends in your circle yet — tell us who’s holding you accountable below.</p>
        )
      ) : (
        <>
          <div className="referee-picker-wrap">
            <input
              className="referee-address-input"
              name="referee"
              placeholder="friend.eth or 0x1234…"
              inputMode="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
          {resolving ? <p className="ens-hint">resolving ens…</p> : null}
          {resolved ? <p className="ens-hint">✓ resolved → {short(addr)}</p> : null}
          {value.trim() && !valid && !resolving ? (
            <p className="muted" style={{ fontSize: 12 }}>
              that doesn't look like a valid wallet address yet
            </p>
          ) : null}
        </>
      )}
      <div className="referee-manual">
        <button type="button" className="toggle-address" onClick={() => setPickFriends((open) => !open)}>
          {pickFriends ? 'or paste a wallet / ens instead' : '← pick a friend instead'}
        </button>
      </div>
      <div className="referee-suggest">
        <span>they decide if you actually did it</span>
        <span>you'll get a link to share after you lock it in</span>
      </div>
      <div className="builder-copy sub accountability-proof-copy">
        <span className="eyebrow tiny">proof standard</span>
        <p className="muted">how will they call it?</p>
      </div>
      <div className="textarea-shell proof-shell">
        <input
          className="proof-input-inline"
          name="proof"
          maxLength={120}
          placeholder="weekly gym pics, a shipped link, check-ins…"
          value={proof}
          onChange={(e) => setProof(e.target.value)}
        />
      </div>
    </div>
  );
}

function Step3Stake({
  stake,
  setStake,
  currency,
  setCurrency,
  usdcEnabled,
  days,
  setDays,
}: {
  stake: string;
  setStake: (s: string) => void;
  currency: StakeCurrency;
  setCurrency: (c: StakeCurrency) => void;
  usdcEnabled: boolean;
  days: number;
  setDays: (d: number) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const amt = parseFloat(stake) || 0;
  const fee = (amt * Number(FEE_BPS)) / 10_000;
  const refund = amt - fee;
  const fmtNum = (n: number) => String(n.toFixed(3)).replace(/\.?0+$/, '');
  const deadlineOptions = [
    { d: 1, label: '1 day' },
    { d: 3, label: '3 days' },
    { d: 7, label: '7 days' },
    { d: 14, label: '14 days' },
    { d: 30, label: '30 days' },
  ];
  const unit = currency;
  const min = currency === 'ETH' ? '0.001' : '1';
  const max = currency === 'ETH' ? '5' : '5000';
  const step = currency === 'ETH' ? '0.01' : '1';
  const placeholder = currency === 'ETH' ? '0.1' : '300';
  const quickAmounts = currency === 'ETH' ? ['0.01', '0.05', '0.1', '0.25'] : ['5', '10', '50', '100'];
  const CoinIcon = ({ coin }: { coin: StakeCurrency }) => (
    <span className={`coin-symbol ${coin.toLowerCase()}`} aria-hidden="true">
      <img src={coin === 'ETH' ? '/eth-coin.png' : '/usdc-coin.png'} alt="" />
    </span>
  );
  return (
    <div className="fade-up-1">
      <div className="builder-copy">
        <span className="eyebrow">stake</span>
        <h3>how much are you putting on it?</h3>
        <p className="muted">make the amount the commitment.</p>
      </div>
      <div className="currency-toggle" role="group" aria-label="stake currency">
        {(['ETH', 'USDC'] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={currency === c ? 'on' : ''}
            onClick={() => setCurrency(c)}
          >
            <CoinIcon coin={c} />
            <span>{c}</span>
          </button>
        ))}
      </div>
      <div className="amount-pressure">
        <div className="amount-row">
          <input
            name="stake"
            type="number"
            inputMode="decimal"
            step={step}
            min={min}
            max={max}
            placeholder={placeholder}
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            className="stake-amount-input"
            aria-label={`stake amount in ${currency}`}
          />
          <span className="stake-unit">{unit}</span>
        </div>
        {usdcEnabled && currency === 'USDC' ? (
          <p className="muted usdc-preview-note">settles in real USDC on base.</p>
        ) : null}
      </div>
      <div className="quick-amount-row" aria-label="quick stake amounts">
        {quickAmounts.map((amount) => (
          <button
            key={amount}
            type="button"
            className={`quick-amount${stake === amount ? ' on' : ''}`}
            onClick={() => setStake(amount)}
          >
            {amount} {unit}
          </button>
        ))}
      </div>
      <label style={{ marginTop: 14 }}>
        deadline
        <div className="deadline-chips">
          {deadlineOptions.map((o) => (
            <button
              key={o.d}
              type="button"
              className={`deadline-chip${days === o.d ? ' on' : ''}`}
              onClick={() => setDays(o.d)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </label>
      <div className="stake-details">
        <button type="button" className="stake-details-toggle" onClick={() => setShowDetails((open) => !open)}>
          <span>what actually happens</span>
          <small>{showDetails ? 'hide' : 'show'} ↓</small>
        </button>
        {showDetails ? (
          <div className="breakdown">
            <div className="breakdown-row green">
              <span>keep your word → money comes back</span>
              <b>{amt ? `${fmtNum(refund)} ${unit}` : '—'}</b>
            </div>
            <div className="breakdown-row red">
              <span>bail → friend takes it</span>
              <b>{amt ? `${fmtNum(refund)} ${unit}` : '—'}</b>
            </div>
            <div className="breakdown-row blue">
              <span>protocol fee (2%)</span>
              <b>{amt ? `${fmtNum(fee)} ${unit}` : '—'}</b>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Step4Review({
  goal,
  proof,
  referee,
  stake,
  currency,
  days,
}: {
  goal: string;
  proof: string;
  referee: string;
  stake: string;
  currency: StakeCurrency;
  days: number;
}) {
  const [createdAt] = useState(() => Date.now());
  const amt = parseFloat(stake) || 0;
  const fmtNum = (n: number) => String(n.toFixed(3)).replace(/\.?0+$/, '');
  const deadline = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(createdAt + days * 86400 * 1000),
  );
  const refereeLabel = referee.startsWith('0x') ? `@${short(referee as `0x${string}`, 4)}` : `@${referee}`;
  return (
    <div className="review-card fade-up-1">
      <span className="eyebrow">send assert</span>
      <h3>ready to make it real?</h3>
      <article className="assert-review-card">
        <span className="assert-review-kicker">i assert</span>
        <h4>{goal}</h4>
        <div className="assert-review-meta">
          <span><b>{fmtNum(amt)} {currency}</b> on the line</span>
          <span><b>{refereeLabel}</b> decides the outcome</span>
          <span><b>deadline</b> · {deadline}</span>
        </div>
        {proof.trim() ? <p>{proof}</p> : null}
      </article>
    </div>
  );
}

function CreateWizard({ onCreated, initialReferee, contacts }: { onCreated: (key: string) => void; initialReferee?: string; contacts: Friend[] }) {
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState('');
  const [proof, setProof] = useState('');
  const [referee, setReferee] = useState(initialReferee ?? '');
  const [stake, setStake] = useState('');
  const [currency, setCurrency] = useState<StakeCurrency>('ETH');
  const [days, setDays] = useState(7);
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resolvedReferee, setResolvedReferee] = useState<`0x${string}` | null>(null);
  const isMockBuilder = import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1';
  const { writeContractAsync, isPending } = useWriteContract();
  const { chainId, address } = useAccount();
  const { switchChain } = useSwitchChain();
  const isBase = chainId === base.id;
  const onTestnet = chainId === baseSepolia.id;
  const isLocal = chainId === localAnvil.id;
  const v2Live = COMMITMENT_V2_ADDRESS !== ZERO_ADDRESS;
  const usdcEnabled = isMockBuilder || isLocal || (isBase && v2Live);
  const publicClient = usePublicClient();

  const stepsLabel = ['promise', 'stake', 'accountability', 'review'];
  const progressLabel = `${stepsLabel[step]} · ${step + 1} of ${stepsLabel.length}`;
  const goalText = `${goal.trim()}\n\nProof standard: ${proof.trim()}`;

  const refereeResult = (() => {
    if (resolvedReferee) return { ok: true, addr: resolvedReferee };
    const raw = referee.trim();
    if (raw.startsWith('0x')) {
      try {
        return { ok: true, addr: getAddress(raw) as `0x${string}` };
      } catch {
        return { ok: false };
      }
    }
    return { ok: raw.endsWith('.eth') && raw.length > 4, ensOnly: true };
  })();

  const canNext =
    step === 0
      ? goal.trim().length > 0
      : step === 1
        ? parseFloat(stake) >= (currency === 'ETH' ? 0.001 : 1)
        : step === 2
          ? refereeResult.ok && !refereeResult.ensOnly
          : true;

  const submittingRef = useRef(false);

  const submit = async () => {
    if (submittingRef.current) return;
    setError('');
    setSubmitting(true);
    submittingRef.current = true;
    const v2Live = COMMITMENT_V2_ADDRESS !== ZERO_ADDRESS;
    const v2Chain = isLocal ? LOCAL_COMMITMENT_V2_ADDRESS : COMMITMENT_V2_ADDRESS;
    const v2Abi = commitmentV2Abi;
    const usdcToken = isLocal ? LOCAL_USDC_ADDRESS : USDC_ADDRESS;
    const createSource: GoalSource = currency === 'USDC' ? 'v2' : 'v1';
    const confirmCreated = async (
      before: bigint,
      contract: `0x${string}`,
      abi: typeof commitmentAbi | typeof commitmentV2Abi,
    ): Promise<bigint | null> => {
      for (let i = 0; i < 15; i++) {
        try {
          const now = (await publicClient!.readContract({
            address: contract,
            abi,
            functionName: 'nextId',
          })) as bigint;
          if (now > before) return now - 1n;
        } catch {
          /* transient rpc — keep polling */
        }
        await new Promise((r) => setTimeout(r, 1300));
      }
      return null;
    };
    try {
      const amt = Number(stake);
      if (currency === 'USDC') {
        if (isLocal || (isBase && v2Live)) {
          /* ok — local mock or live V2 */
        } else if (isBase && !v2Live) {
          setError('USDC asserts aren\'t live yet — the V2 contract isn\'t deployed. Pick ETH for now.');
          return;
        } else {
          setError('USDC asserts run on Base mainnet (or Anvil Local while testing). Switch your wallet.');
          return;
        }
      } else if (chainId !== base.id && chainId !== baseSepolia.id) {
        setError('switch your wallet to base before creating.');
        return;
      }
      if (!amt || amt < (currency === 'USDC' ? 1 : 0.001)) {
        setError(currency === 'USDC' ? 'stake must be at least 1 USDC.' : 'stake must be at least 0.001 ETH.');
        return;
      }
      if (amt > (currency === 'USDC' ? 5000 : 5)) {
        setError(currency === 'USDC' ? 'stake can\'t exceed 5000 USDC.' : 'stake can\'t exceed 5 ETH.');
        return;
      }
      if (goalText.length > 280) {
        setError(`keep goal + proof under 280 characters (currently ${goalText.length}).`);
        return;
      }
      if (address && refereeResult.addr!.toLowerCase() === address.toLowerCase()) {
        setError('referee can\'t be your own wallet.');
        return;
      }
      if (isMockBuilder) {
        await new Promise((r) => setTimeout(r, 550));
        onCreated(goalKey(1n, currency === 'USDC' ? 'v2' : 'v1'));
        return;
      }
      const deadline = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
      const createAddress = currency === 'USDC' ? v2Chain : COMMITMENT_ADDRESS;
      const createAbi = currency === 'USDC' ? v2Abi : commitmentAbi;
      let before = 0n;
      try {
        before = (await publicClient!.readContract({
          address: createAddress,
          abi: createAbi,
          functionName: 'nextId',
        })) as bigint;
      } catch {
        /* ignore */
      }

      let gh: `0x${string}` | undefined;
      try {
        if (currency === 'USDC') {
          const stakeAmount = parseUnits(stake, 6);
          const owner = address!;
          const balance = (await publicClient!.readContract({
            address: usdcToken,
            abi: erc20TestAbi,
            functionName: 'balanceOf',
            args: [owner],
          })) as bigint;
          if (isLocal && balance < stakeAmount) {
            const mintHash = await writeContractAsync({
              chainId: localAnvil.id,
              address: LOCAL_USDC_ADDRESS,
              abi: erc20TestAbi,
              functionName: 'mint',
              args: [owner, stakeAmount - balance],
            });
            await waitForTx(mintHash, localAnvil.id);
          }
          if (balance < stakeAmount && !isLocal) {
            setError(`you need ${stake} USDC in your wallet to make this assert. go swap or bridge some, then try again.`);
            return;
          }
          const allowance = (await publicClient!.readContract({
            address: usdcToken,
            abi: erc20TestAbi,
            functionName: 'allowance',
            args: [owner, createAddress],
          })) as bigint;
          if (allowance < stakeAmount) {
            const approveHash = await writeContractAsync({
              chainId,
              address: usdcToken,
              abi: erc20TestAbi,
              functionName: 'approve',
              args: [createAddress, stakeAmount],
            });
            await waitForTx(approveHash, chainId);
          }
          gh = await writeContractAsync({
            chainId,
            address: createAddress,
            abi: commitmentV2Abi,
            functionName: 'createGoalWithToken',
            args: [goalText, refereeResult.addr!, deadline, usdcToken, stakeAmount],
          });
        } else {
          gh = await writeContractAsync({
            address: COMMITMENT_ADDRESS,
            abi: commitmentAbi,
            functionName: 'createGoal',
            args: [goalText, refereeResult.addr!, deadline],
            value: parseUnits(stake, 18),
          });
        }
      } catch (e: any) {
        // the tx may have landed anyway (stale wallet prompt / broadcast race) —
        // confirm onchain before blaming the user
        const landed = await confirmCreated(before, createAddress, createAbi);
        if (landed !== null) {
          onCreated(goalKey(landed, createSource));
          return;
        }
        const code = e?.cause?.code ?? e?.code;
        const base =
          code === 4001
            ? 'you rejected the transaction in your wallet.'
            : e?.shortMessage?.includes('reverted') || e?.cause?.data
              ? 'the contract rejected this — check your stake, referee and deadline.'
              : e?.shortMessage ?? e?.message ?? 'transaction failed';
        setError(`${base}${code ? ` (code ${code})` : ''}`);
        return;
      }

      setTxHash(gh);
      try {
        await waitForTx(gh, currency === 'USDC' ? chainId : undefined);
      } catch {
        /* receipt wait can time out even when the tx already mined — confirm below */
      }

      // pin the created id from the event log
      try {
        const receipt = await publicClient!.getTransactionReceipt({ hash: gh });
        const ev = getAbiItem({ abi: createAbi, name: 'Created' });
        const logs = await publicClient!.getLogs({
          address: createAddress,
          event: ev,
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber,
        });
        const created = logs.find((l) => l.transactionHash === gh);
        const args = created?.args as CreatedArgs | undefined;
        if (args?.id) {
          onCreated(goalKey(args.id, createSource));
          return;
        }
      } catch {
        /* non-fatal */
      }
      const createdId = await confirmCreated(before, createAddress, createAbi);
      onCreated(createdId !== null ? goalKey(createdId, createSource) : '0');
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <form
      className="create-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="wizard-head">
        <span className="wizard-progress-label">{progressLabel}</span>
        <h2>new assert</h2>
        <div className="network-chip-row">
          {onTestnet ? (
            <span className="network-chip testnet">base sepolia · testnet</span>
          ) : isLocal ? (
            <span className="network-chip testnet">anvil · local</span>
          ) : isBase ? (
            <span className="network-chip mainnet">base · mainnet</span>
          ) : usdcEnabled && currency === 'USDC' && !isBase ? (
            <button type="button" className="network-chip switch" onClick={() => switchChain({ chainId: localAnvil.id })}>
              switch to anvil ↻
            </button>
          ) : (
            <button type="button" className="network-chip switch" onClick={() => switchChain({ chainId: base.id })}>
              switch to base ↻
            </button>
          )}
        </div>
        <div className="steps-track">
          {stepsLabel.map((s, i) => (
            <div
              key={s}
              className={`step-dot${i < step ? ' done' : i === step ? ' on' : ''}`}
              title={s}
            />
          ))}
        </div>
        {step < 2 && initialReferee ? (
          <div className="wizard-referee-note">
            adding <b>{initialReferee.startsWith('0x') ? short(initialReferee as `0x${string}`, 4) : initialReferee}</b>{' '}
            to your circle — write what you're calling them out on.
          </div>
        ) : null}
      </div>

      {step === 0 && <Step1Goal goal={goal} setGoal={setGoal} proof={proof} setProof={setProof} />}
      {step === 1 && (
        <Step3Stake
          stake={stake}
          setStake={setStake}
          currency={currency}
          setCurrency={setCurrency}
          usdcEnabled={usdcEnabled}
          days={days}
          setDays={setDays}
        />
      )}
      {step === 2 && (
        <Step2Referee
          value={referee}
          onChange={setReferee}
          onResolved={setResolvedReferee}
          friends={contacts}
          proof={proof}
          setProof={setProof}
        />
      )}
      {step === 3 && <Step4Review goal={goal} proof={proof} referee={refereeResult.addr ?? referee} stake={stake} currency={currency} days={days} />}

      {error && <p className="muted" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
      {submitting && !txHash && (
        <p className="muted" style={{ fontSize: 13 }}>
          waiting for your wallet to sign…
        </p>
      )}
      {txHash && !isPending && (
        <p className="muted" style={{ color: 'var(--green)', fontSize: 13 }}>
          ✓ locked in onchain
        </p>
      )}

      <div className="wizard-nav">
        {step > 0 ? (
          <button type="button" className="btn" onClick={() => setStep((s) => s - 1)}>
            ← back
          </button>
        ) : (
          <span />
        )}
        {step < 3 ? (
          <button
            type="button"
            className="btn-primary"
            disabled={!canNext}
            onClick={() => setStep((s) => s + 1)}
          >
            next →
          </button>
        ) : (
          <SlideToAssert
            disabled={submitting || isPending}
            processing={submitting || isPending}
            error={error}
            onComplete={submit}
          />
        )}
      </div>
    </form>
  );
}

function ConnectedIntro({ onStart, profile }: { onStart: () => void; profile: UserProfile }) {
  return (
    <section className="intro-scene">
      <div className="intro-profile intro-line intro-line-1">
        <ProfileAvatar profile={profile} />
        {profile.locked ? (
          <span>{profile.username}</span>
        ) : (
          <img className="intro-wordmark" src="/wordmark.png" alt="assert" />
        )}
      </div>
      <h2 className="intro-line intro-line-2">you ready to become a more disciplined version of yourself?</h2>
      <p className="intro-line intro-line-3">
        this is where excuses get expensive. choose what you’re done tolerating.
      </p>
      <button className="btn-primary intro-start intro-line intro-line-4" onClick={onStart}>
        enter assert →
      </button>
    </section>
  );
}

/* ---------------- entry scene (pre-auth) ---------------- */

type EntryFloatSpec = {
  icon: React.ReactNode;
  cls: string;
};

function FloatAlarm() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <rect x="10" y="18" width="28" height="22" rx="4" fill="#eef1ff" stroke="#405cff" strokeWidth="1.8" />
      <circle cx="24" cy="29" r="7.5" fill="#fff" stroke="#405cff" strokeWidth="1.4" />
      <line x1="24" y1="29" x2="24" y2="24.5" stroke="#405cff" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="24" y1="29" x2="27.5" y2="29" stroke="#405cff" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="13" cy="15" r="3.5" fill="#405cff" />
      <circle cx="35" cy="15" r="3.5" fill="#405cff" />
      <line x1="16.5" y1="15" x2="31.5" y2="15" stroke="#405cff" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="24" cy="10" r="1.5" fill="#405cff" />
      <line x1="14" y1="40" x2="18" y2="37" stroke="#c5cffc" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="34" y1="40" x2="30" y2="37" stroke="#c5cffc" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function FloatDumbbell() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <rect x="7" y="18" width="6" height="12" rx="2" fill="#405cff" />
      <rect x="35" y="18" width="6" height="12" rx="2" fill="#405cff" />
      <rect x="12" y="21" width="24" height="6" rx="2" fill="#eef1ff" stroke="#405cff" strokeWidth="1.2" />
      <rect x="4" y="20" width="5" height="8" rx="1.5" fill="#2f46d6" />
      <rect x="39" y="20" width="5" height="8" rx="1.5" fill="#2f46d6" />
      <rect x="12.5" y="21.5" width="23" height="2.5" rx="1" fill="#fff" opacity="0.5" />
    </svg>
  );
}

function FloatBook() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <path d="M24 14 C24 14 14 12 8 14 L8 38 C14 36 24 38 24 38 C24 38 34 36 40 38 L40 14 C34 12 24 14 24 14Z" fill="#eef1ff" stroke="#405cff" strokeWidth="1.6" />
      <path d="M24 14 C24 14 14 12 8 14 L8 38 C14 36 24 38 24 38Z" fill="#f5f7ff" stroke="#405cff" strokeWidth="1.6" />
      <line x1="13" y1="20" x2="20" y2="20.5" stroke="#405cff" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
      <line x1="13" y1="24" x2="19" y2="24.5" stroke="#405cff" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
      <line x1="13" y1="28" x2="18" y2="28.5" stroke="#405cff" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
      <line x1="28" y1="20" x2="35" y2="19.5" stroke="#405cff" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
      <line x1="28" y1="24" x2="34" y2="23.5" stroke="#405cff" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

function FloatRocket() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <path d="M24 6 C24 6 18 16 18 26 L30 26 C30 16 24 6 24 6Z" fill="#eef1ff" stroke="#405cff" strokeWidth="1.6" />
      <circle cx="24" cy="20" r="2.5" fill="#405cff" />
      <path d="M18 26 L14 32 L18 30Z" fill="#405cff" />
      <path d="M30 26 L34 32 L30 30Z" fill="#405cff" />
      <rect x="20" y="26" width="8" height="4" rx="1" fill="#2f46d6" />
      <path d="M21 30 L24 38 L27 30Z" fill="#c5cffc" />
      <path d="M22.5 30 L24 35 L25.5 30Z" fill="#405cff" opacity="0.4" />
    </svg>
  );
}

function FloatShoe() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <path d="M8 32 C8 32 8 26 14 24 C20 22 22 20 28 18 C34 16 38 17 40 20 C42 23 40 28 38 30 L10 34 C8 34 8 32 8 32Z" fill="#eef1ff" stroke="#405cff" strokeWidth="1.6" />
      <path d="M10 34 L38 30 L39 33 C39 35 37 36 35 36 L12 36 C10 36 9 35 10 34Z" fill="#405cff" />
      <circle cx="18" cy="26" r="1.2" fill="#405cff" opacity="0.4" />
      <circle cx="22" cy="24.5" r="1.2" fill="#405cff" opacity="0.4" />
      <circle cx="26" cy="23" r="1.2" fill="#405cff" opacity="0.4" />
      <path d="M8 32 C8 32 10 28 16 26" stroke="#fff" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

function FloatHourglass() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <rect x="14" y="6" width="20" height="3" rx="1.5" fill="#405cff" />
      <rect x="14" y="39" width="20" height="3" rx="1.5" fill="#405cff" />
      <path d="M16 9 L16 19 C16 24 21 26 24 26 C27 26 32 24 32 19 L32 9Z" fill="#eef1ff" stroke="#405cff" strokeWidth="1.4" />
      <path d="M16 39 L16 29 C16 24 21 22 24 22 C27 22 32 24 32 29 L32 39Z" fill="#f5f7ff" stroke="#405cff" strokeWidth="1.4" />
      <path d="M20 26 L24 38 L28 26Z" fill="#c5cffc" opacity="0.7" />
      <ellipse cx="24" cy="20" rx="4" ry="1.5" fill="#405cff" opacity="0.35" />
    </svg>
  );
}

function FloatCoin() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <ellipse cx="24" cy="24" rx="15" ry="16" fill="#eef1ff" stroke="#405cff" strokeWidth="1.6" />
      <ellipse cx="24" cy="26" rx="15" ry="16" fill="#f5f7ff" stroke="#405cff" strokeWidth="0" opacity="0.5" />
      <ellipse cx="24" cy="24" rx="15" ry="16" fill="none" stroke="#405cff" strokeWidth="1.6" />
      <ellipse cx="24" cy="24" rx="11" ry="12" fill="none" stroke="#c5cffc" strokeWidth="1" />
      <text x="24" y="29" textAnchor="middle" fill="#405cff" fontFamily="var(--font-display)" fontWeight="800" fontSize="14">A</text>
      <ellipse cx="20" cy="17" rx="5" ry="2" fill="#fff" opacity="0.4" transform="rotate(-15 20 17)" />
    </svg>
  );
}

function FloatTarget() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <circle cx="24" cy="24" r="16" fill="#eef1ff" stroke="#405cff" strokeWidth="1.4" />
      <circle cx="24" cy="24" r="11" fill="#f5f7ff" stroke="#c5cffc" strokeWidth="1.2" />
      <circle cx="24" cy="24" r="6" fill="#fff" stroke="#405cff" strokeWidth="1.4" />
      <circle cx="24" cy="24" r="2.5" fill="#405cff" />
      <line x1="24" y1="6" x2="24" y2="10" stroke="#405cff" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="24" y1="38" x2="24" y2="42" stroke="#405cff" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="6" y1="24" x2="10" y2="24" stroke="#405cff" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="38" y1="24" x2="42" y2="24" stroke="#405cff" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function FloatCalendar() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <rect x="10" y="12" width="28" height="28" rx="5" fill="#eef1ff" stroke="#405cff" strokeWidth="1.6" />
      <path d="M10 20H38" stroke="#405cff" strokeWidth="1.5" />
      <rect x="15" y="8" width="4" height="8" rx="2" fill="#405cff" />
      <rect x="29" y="8" width="4" height="8" rx="2" fill="#405cff" />
      <rect x="16" y="25" width="5" height="5" rx="1.5" fill="#c5cffc" />
      <rect x="23" y="25" width="5" height="5" rx="1.5" fill="#405cff" opacity="0.72" />
      <rect x="30" y="25" width="5" height="5" rx="1.5" fill="#c5cffc" />
      <path d="M18 35L21 37.5L27 32" stroke="#405cff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FloatBoltCheck() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="entry-float-svg">
      <path d="M27 5L11 27H23L19 43L37 19H25L27 5Z" fill="#eef1ff" stroke="#405cff" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="33" cy="33" r="9" fill="#fff" stroke="#405cff" strokeWidth="1.5" />
      <path d="M29 33.5L32 36L37 29.5" stroke="#405cff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ENTRY_FLOATS: EntryFloatSpec[] = [
  { icon: <FloatAlarm />, cls: 'ef-1' },
  { icon: <FloatDumbbell />, cls: 'ef-2' },
  { icon: <FloatBook />, cls: 'ef-3' },
  { icon: <FloatRocket />, cls: 'ef-4' },
  { icon: <FloatShoe />, cls: 'ef-5' },
  { icon: <FloatHourglass />, cls: 'ef-6' },
  { icon: <FloatCoin />, cls: 'ef-7' },
  { icon: <FloatTarget />, cls: 'ef-8' },
  { icon: <FloatCalendar />, cls: 'ef-9' },
  { icon: <FloatBoltCheck />, cls: 'ef-10' },
];

function EntryScene() {
  return (
    <section className="entry-scene">
      <div className="entry-orbit" aria-hidden="true">
        {ENTRY_FLOATS.map((f) => (
          <div key={f.cls} className={`entry-float ${f.cls}`}>
            {f.icon}
          </div>
        ))}
      </div>
      <div className="entry-identity entry-rise-1">
        <img className="entry-wordmark" src="/wordmark.png" alt="assert" />
        <p className="entry-tagline">put anything on the line.</p>
      </div>
      <div className="entry-cta entry-rise-2">
        <ConnectButton label="Get Started" />
        <p className="entry-legal">
          on your honor, onchain · <a className="legal-inline" href="#/terms">terms</a> ·{' '}
          <a className="legal-inline" href="#/privacy">privacy</a>
        </p>
      </div>
    </section>
  );
}

type SocialFeedItem = {
  who: string;
  action: string;
  body: string;
  meta: string;
  badge: 'won' | 'live' | 'day' | 'folded';
  reaction: string;
  result?: string;
  pfp?: string;
  id?: string;
};

function splitGoalText(text: string): { title: string; description?: string } {
  const idx = text.indexOf('\n\n');
  if (idx === -1) return { title: text.trim() };
  return { title: text.slice(0, idx).trim(), description: text.slice(idx + 2).trim() };
}

function activityFromGoals(
  goals: CreatedArgs[],
  statuses: (GoalStruct | undefined)[],
  opts: { me?: `0x${string}`; contacts: `0x${string}`[]; profiles: Record<string, UserProfile> },
): SocialFeedItem[] {
  const me = opts.me?.toLowerCase() ?? '';
  const isContact = new Set(opts.contacts.map((c) => c.toLowerCase()));
  return goals.map((g, i) => {
    const st = statuses[i]?.[6];
    const whoIsMe = g.creator.toLowerCase() === me;
    const whoInCircle = isContact.has(g.creator.toLowerCase());
    const who = whoIsMe ? 'you' : (whoInCircle ? (opts.profiles[g.creator]?.username ?? short(g.creator, 3)) : short(g.creator, 3));
    const badge: SocialFeedItem['badge'] =
      st === 2 ? 'won' : st === 3 ? 'folded' : st === 1 ? 'live' : 'day';
    const action = st === 2 ? 'won the assert' : st === 3 ? 'bailed on' : st === 4 ? 'cancelled' : st === 0 ? 'asserted' : 'is pushing';
    const refereeName = g.referee.toLowerCase() === me ? 'you' : short(g.referee, 3);
    const meta = st === 0 ? `waiting on ${refereeName}` : `referee: ${refereeName}`;
    const result =
      st === 2
        ? `+${fmtAmount(g.amount, g.source, 3)} ${unitOf(g.source)} kept`
        : st === 3
          ? `${fmtAmount(g.amount, g.source, 3)} ${unitOf(g.source)} → referee`
          : st === 4
            ? 'refunded'
            : undefined;
    return {
      who,
      action,
      body: splitGoalText(g.goalText).title,
      meta,
      badge,
      reaction: '0',
      result,
      id: goalKey(g.id, g.source),
      pfp: opts.profiles[g.creator]?.pfpUrl ?? '',
    };
  });
}

const PILL_LABEL: Record<SocialFeedItem['badge'], string> = { won: 'WON', live: 'LIVE', day: 'DAY 5', folded: 'FOLDED' };

function SocialFeedRow({ item }: { item: SocialFeedItem }) {
  const [hearted, setHearted] = useState(false);
  const reaction = Number(item.reaction) + (hearted ? 1 : 0);
  return (
    <div className={`feed-item ${item.badge}`}>
      {item.pfp ? (
        <img className="avatar feed-avatar" src={item.pfp} alt={item.who} />
      ) : (
        <div className="avatar feed-avatar">{item.who[0]}</div>
      )}
      <div className="feed-item-main">
        <div className="feed-item-top">
          <b className="feed-name">{item.who}</b>
          <span className="feed-pill">{PILL_LABEL[item.badge]}</span>
          {item.result ? <span className={`feed-result ${item.badge}`}>{item.result}</span> : null}
        </div>
        <p className="feed-item-body">{item.action} <strong>{item.body}</strong></p>
        <span className="feed-item-meta">{item.meta}</span>
        <div className="feed-actions">
          <button
            type="button"
            className={`feed-heart${hearted ? ' on' : ''}`}
            aria-pressed={hearted}
            onClick={(e) => { e.stopPropagation(); setHearted((h) => !h); }}
            aria-label="react"
          >
            {hearted ? '♥' : '♡'} {reaction}
          </button>
          {item.id ? <a href={`#g/${item.id}`} className="feed-open">open assert →</a> : null}
        </div>
      </div>
    </div>
  );
}

function SocialFeed({ rows }: { rows: SocialFeedItem[] }) {
  return (
    <div className="social-feed">
      {rows.map((item) => (
        <SocialFeedRow key={`${item.who}-${item.body}`} item={item} />
      ))}
    </div>
  );
}

type AppMode = 'intro' | 'home' | 'asserts' | 'builder' | 'friends' | 'you';
type AssertFilter = 'Live' | 'Pending' | 'Won' | 'Bailed';

const FILTERS: AssertFilter[] = ['Live', 'Pending', 'Won', 'Bailed'];

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CaretIcon({ up = false }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={up ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
}

function SlideToAssert({
  disabled = false,
  processing = false,
  error = '',
  onComplete,
}: {
  disabled?: boolean;
  processing?: boolean;
  error?: string;
  onComplete: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [p, setP] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);
  const startX = useRef(0);
  const startP = useRef(0);
  const doneRef = useRef(false);
  const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    doneRef.current = done;
  }, [done]);

  useEffect(
    () => () => {
      if (completeTimer.current) clearTimeout(completeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (error && doneRef.current) {
      doneRef.current = false;
      setDone(false);
      setP(0);
    }
  }, [error]);

  const fireComplete = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setDone(true);
    setP(1);
    setDragging(false);
    try {
      if (typeof navigator.vibrate === 'function') navigator.vibrate(20);
    } catch {
      /* unsupported */
    }
    completeTimer.current = setTimeout(onComplete, 140);
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || doneRef.current) return;
    startX.current = e.clientX;
    startP.current = p;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || trackRef.current == null) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width === 0) return;
    const next = Math.min(1, Math.max(0, startP.current + (e.clientX - startX.current) / rect.width));
    if (next >= 0.985) {
      fireComplete();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      return;
    }
    setP(next);
  };

  const onUp = () => {
    if (!dragging) return;
    setDragging(false);
    setP((v) => {
      if (v >= 0.9 && !doneRef.current) {
        fireComplete();
      }
      return v >= 0.9 && !doneRef.current ? v : 0;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || doneRef.current) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(1, p + 0.08);
      if (next >= 1) fireComplete();
      else setP(next);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      setP((v) => Math.max(0, v - 0.08));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (p > 0) fireComplete();
    }
  };

  const label = processing ? 'waiting for your wallet…' : done ? 'asserting…' : 'slide to assert →';

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="slide to assert"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p * 100)}
      className={`slide-assert${done ? ' done' : ''}${processing ? ' processing' : ''}${dragging ? ' dragging' : ''}${disabled ? ' disabled' : ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKeyDown}
    >
      <span className="slide-assert-fill" style={{ width: `${p * 100}%` }} />
      <span className="slide-assert-label">{label}</span>
      <span
        className="slide-assert-thumb"
        style={{ left: `calc(${p * 100}% - ${p * 52}px)`, transition: dragging ? 'none' : undefined }}
      >
        {done ? <CheckIcon /> : <ArrowRightIcon />}
      </span>
    </div>
  );
}

function HomeAssertCard({ goal, status, profiles = {}, compact = false, isOpen = false, onToggle }: { goal: CreatedArgs; status: number; profiles?: Record<string, UserProfile>; compact?: boolean; isOpen?: boolean; onToggle?: () => void }) {
  const { address } = useAccount();
  const cd = useCountdown(goal.deadline);
  const refereeName = profileName(goal.referee, profiles);
  const isCreator = address !== undefined && goal.creator.toLowerCase() === address.toLowerCase();
  const isReferee = address !== undefined && goal.referee.toLowerCase() === address.toLowerCase();
  const title = splitGoalText(goal.goalText).title;
  const label = status === 0 ? 'Pending' : 'Live';
  const live = status === 1;
  const unit = unitOf(goal.source);
  if (compact) {
    return (
      <article
        className={`home-assert-compact${live ? ' live' : ''}${isOpen ? ' open' : ''}`}
        role={onToggle ? 'button' : undefined}
        tabIndex={onToggle ? 0 : undefined}
        onClick={onToggle}
        onKeyDown={onToggle ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } } : undefined}
      >
        <span className={`live-pill ${label.toLowerCase()}`}>{label}</span>
        <div className="home-assert-compact-main">
          <h3>{title}</h3>
          <span className="home-assert-compact-sub">
            {cd.expired ? 'referee calls it' : `${cd.out} left`}
          </span>
        </div>
        <b className="home-assert-compact-amount">{fmtAmount(goal.amount, goal.source, 3)} {unit}</b>
        {onToggle ? <span className="home-assert-caret"><CaretIcon up={isOpen} /></span> : null}
      </article>
    );
  }
  return (
    <article className={`home-assert-card${live ? ' live' : ''}${isReferee ? ' referee' : ''}`}>
      <div className="assert-pass-top">
        <span className={`live-pill ${label.toLowerCase()}`}>{label}</span>
        {isReferee && (
          <span className="referee-tag">
            <span className="referee-tag-dot" />
            you're the referee
          </span>
        )}
        <b>{fmtAmount(goal.amount, goal.source, 3)} {unit}</b>
      </div>
      <h3>{title}</h3>
      <div className="home-assert-state">
        <ClockIcon />
        <div>
          {live ? (
            <>
              <span className="state-line">{isReferee ? 'you\'re refereeing this' : `${refereeName} is watching`}</span>
              <span className="state-sub">
                {cd.expired ? 'time is up · referee calls it within 2 days' : `${cd.out} left`} · {isReferee ? 'you' : refereeName} takes {fmtAmount(goal.amount, goal.source, 3)} {unit} if they bail
              </span>
            </>
          ) : (
            <>
              <span className="state-line">Waiting on your friend.</span>
              <span className="state-sub">Your assert goes live once they accept.</span>
            </>
          )}
        </div>
      </div>
      <div className={`home-assert-actions${isCreator ? '' : ' single'}`}>
        <a href={`#g/${goalKey(goal.id, goal.source)}`} className="home-assert-action">View assert →</a>
        {isCreator ? (
          <a
            href={assertShareHref({ id: goal.id, title, amount: goal.amount, status, source: goal.source })}
            className="home-assert-action share-action"
            target="_blank"
            rel="noreferrer"
          >
            <ShareOnXLabel />
          </a>
        ) : null}
      </div>
    </article>
  );
}

function AssertsTab({
  myGoals,
  profiles = {},
  statuses = [],
  readOnly = false,
}: {
  myGoals: CreatedArgs[];
  profiles?: Record<string, UserProfile>;
  statuses?: (GoalStruct | undefined)[];
  readOnly?: boolean;
}) {
  const [filter, setFilter] = useState<AssertFilter>('Pending');
  return (
    <div className="social-app">
      <section className="tab-shell">
        <div className="tab-head">
          <span className="eyebrow">asserts</span>
          <h2>your promises</h2>
        </div>
        <div className="filter-row">
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <div className="assert-card-list">
          {myGoals.length ? (
            myGoals.map((g, i) => <GoalCard key={goalKey(g.id, g.source)} id={goalKey(g.id, g.source)} only={filter} profiles={profiles} fallback={{ goal: g, status: statuses[i]?.[6] ?? 0 }} readOnly={readOnly} />)
          ) : (
            <p className="empty-copy">nothing {filter.toLowerCase()} yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function FriendsTab({
  requests,
  deniedGoals,
  contacts,
  profiles,
  address,
  onStart,
  onAddFriend,
  onDenied,
  feed,
  myGoals,
  statuses,
  followedIds,
  onToggleFollow,
  readOnly = false,
}: {
  requests: CreatedArgs[];
  deniedGoals: CreatedArgs[];
  contacts: `0x${string}`[];
  profiles: Record<string, UserProfile>;
  address?: `0x${string}`;
  onStart: (friend?: Friend) => void;
  onAddFriend: (address: `0x${string}`) => void;
  onDenied: (denial: StoredRefereeDenial) => void;
  feed: SocialFeedItem[];
  myGoals: CreatedArgs[];
  statuses: (GoalStruct | undefined)[];
  followedIds: string[];
  onToggleFollow: (id: bigint | string) => void;
  readOnly?: boolean;
}) {
  const { writeContractAsync, isPending } = useWriteContract();
  const dismissKey = address ? `assert-dismiss-referee:${address.toLowerCase()}` : '';
  const hiddenFriendKey = address ? `assert-hidden-friends:${address.toLowerCase()}` : '';
  const [dismissed, setDismissed] = useState<string[]>(() => {
    if (!address) return [];
    return readStringList(dismissKey);
  });
  const [hiddenFriends, setHiddenFriends] = useState<string[]>(() => {
    if (!address) return [];
    return readStringList(hiddenFriendKey);
  });
  const [openFriend, setOpenFriend] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addAddr, setAddAddr] = useState('');
  const [addError, setAddError] = useState('');
  const [requestError, setRequestError] = useState('');
  const visibleRequests = requests.filter((r) => !dismissed.includes(goalKey(r.id, r.source)));
  const [filter, setFilter] = useState('');
  const filteredContacts = contacts.filter(
    (a) => !hiddenFriends.includes(a.toLowerCase()) && (!filter || short(a, 4).toLowerCase().includes(filter.toLowerCase())),
  );
  const submitAdd = () => {
    const raw = addAddr.trim();
    if (raw.toLowerCase().endsWith('.eth')) {
      setAddError('paste the wallet address (0x…) — ENS resolves inside the assert flow.');
      return;
    }
    try {
      onAddFriend(getAddress(raw));
      setAdding(false);
      setAddAddr('');
      setAddError('');
    } catch {
      setAddError('that doesn\'t look like a valid address.');
    }
  };
  const accept = async (g: CreatedArgs) => {
    const addressFor = g.source === 'v2' ? COMMITMENT_V2_ADDRESS : COMMITMENT_ADDRESS;
    const abiFor = g.source === 'v2' ? commitmentV2Abi : commitmentAbi;
    const h = await writeContractAsync({ chainId: base.id, address: addressFor, abi: abiFor, functionName: 'acceptRole', args: [g.id], gas: ACCEPT_ROLE_GAS });
    await waitForTx(h);
    window.location.reload();
  };
  const persistPreferences = (nextDismissed: string[], nextHiddenFriends: string[]) => {
    if (!address) return;
    localStorage.setItem(dismissKey, JSON.stringify(nextDismissed));
    localStorage.setItem(hiddenFriendKey, JSON.stringify(nextHiddenFriends));
    saveStoredPreferences({
      wallet_address: address,
      dismissed_request_ids: nextDismissed,
      hidden_friend_addresses: nextHiddenFriends,
      followed_goal_ids: followedIds,
    }).catch((error) => console.warn('Supabase preferences save failed', error));
  };
  const dismiss = (g: CreatedArgs) => {
    const next = [...dismissed, goalKey(g.id, g.source)];
    setDismissed(next);
    persistPreferences(next, hiddenFriends);
  };
  const deny = async (goal: CreatedArgs) => {
    setRequestError('');
    try {
      const denial = await saveRefereeDenial({
        goal_id: goalKey(goal.id, goal.source),
        creator_wallet: goal.creator,
        referee_wallet: goal.referee,
      });
      onDenied(denial);
      dismiss(goal);
    } catch {
      setRequestError('could not notify them yet. try again in a minute.');
    }
  };
  const unfriend = (friendAddress: `0x${string}`) => {
    const next = [...hiddenFriends, friendAddress.toLowerCase()];
    setHiddenFriends(next);
    setOpenFriend(null);
    persistPreferences(dismissed, next);
  };
  const friendDetail = (friendAddress: `0x${string}`) => {
    const together = myGoals.filter((g) => g.creator === friendAddress || g.referee === friendAddress);
    const openTotal = together.reduce((sum, g) => {
      const status = statuses[myGoals.indexOf(g)]?.[6];
      return status === 0 || status === 1 ? sum + Number(formatUnits(g.amount, g.source === 'v2' ? 6 : 18)) : sum;
    }, 0);
    const assertCopy = `${together.length} assert${together.length === 1 ? '' : 's'} together`;
    return openTotal ? `${assertCopy} · ${openTotal.toFixed(3).replace(/\.?0+$/, '')} on the line` : assertCopy;
  };
  useEffect(() => {
    if (!address) return;
    const localDismissed = readStringList(dismissKey);
    const localHiddenFriends = readStringList(hiddenFriendKey);
    setDismissed(localDismissed);
    setHiddenFriends(localHiddenFriends);
    let cancelled = false;
    readStoredPreferences(address)
      .then((stored) => {
        if (!stored || cancelled) return;
        const nextDismissed = [...new Set([...localDismissed, ...stored.dismissed_request_ids])];
        const nextHiddenFriends = [
          ...new Set([...localHiddenFriends, ...stored.hidden_friend_addresses.map((a) => a.toLowerCase())]),
        ];
        setDismissed(nextDismissed);
        setHiddenFriends(nextHiddenFriends);
        localStorage.setItem(dismissKey, JSON.stringify(nextDismissed));
        localStorage.setItem(hiddenFriendKey, JSON.stringify(nextHiddenFriends));
      })
      .catch((error) => console.warn('Supabase preferences load failed', error));
    return () => {
      cancelled = true;
    };
  }, [address, dismissKey, hiddenFriendKey]);
  return (
    <div className="social-app">
      <section className="tab-shell">
        <div className="tab-head">
          <span className="eyebrow">friends</span>
          <h2>your circle</h2>
        </div>
        {requestError ? <p className="friend-add-error">{requestError}</p> : null}
        <DeniedRequests goals={deniedGoals} profiles={profiles} />
        {visibleRequests.length ? (
          <div className="friend-requests">
            {visibleRequests.map((g) => (
              <div className="friend-card-wrap request-card" key={goalKey(g.id, g.source)}>
                <div className="friend-card">
                  <MiniAvatar name={short(g.creator, 4)} />
                  <div>
                    <h3>{short(g.creator, 4)} called you in</h3>
                    <p>{g.goalText}</p>
                    <b>{fmtAmount(g.amount, g.source, 3)} {unitOf(g.source)}</b>
                  </div>
                </div>
                <div className="friend-bubble request-actions" role="group">
                  <button type="button" className="btn green" onClick={() => accept(g)} disabled={isPending}>
                    {isPending ? 'accepting…' : 'accept role'}
                  </button>
                  <a href={`#g/${goalKey(g.id, g.source)}`} className="btn ghost view-assert">view assert →</a>
                  <button type="button" className="btn ghost" onClick={() => deny(g)} disabled={isPending}>
                    deny request
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="friend-toolbar">
          <input className="friend-search" placeholder="search friends" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {adding ? (
            <div className="friend-add">
              <div className="friend-add-row">
                <input
                  autoFocus
                  placeholder="wallet address 0x…"
                  value={addAddr}
                  onChange={(e) => {
                    setAddAddr(e.target.value);
                    setAddError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitAdd();
                  }}
                />
                <button type="button" className="small-blue" onClick={submitAdd} disabled={!addAddr.trim()}>add & assert</button>
                <button type="button" className="small-ghost" onClick={() => { setAdding(false); setAddAddr(''); setAddError(''); }}>cancel</button>
              </div>
              <p className="muted friend-add-hint">friends join your circle when you put an assert on the line together.</p>
              {addError ? <p className="friend-add-error">{addError}</p> : null}
            </div>
          ) : (
            <button type="button" className="small-blue" onClick={() => setAdding(true)}>+ add friend</button>
          )}
        </div>
        <div className="friend-list">
          {filteredContacts.length ? (
            filteredContacts.map((a) => {
              const f: Friend = {
                name: profiles[a]?.username ?? short(a, 4),
                role: 'peer',
                record: '',
                detail: short(a, 6),
                pfp: profiles[a]?.pfpUrl ?? '',
                address: a,
              };
              return (
                <div className="friend-card-wrap" key={a}>
                  <button
                    className="friend-card"
                    type="button"
                    aria-expanded={openFriend === a}
                    onClick={() => setOpenFriend((current) => (current === a ? null : a))}
                  >
                    <MiniAvatar name={f.name} src={f.pfp} />
                    <div>
                      <h3>{f.name}</h3>
                      <p>{friendDetail(a)}</p>
                    </div>
                    <div className="friend-meta"><b>→</b></div>
                  </button>
                  {openFriend === a ? (
                    <div className="friend-bubble" role="menu">
                      <button type="button" onClick={() => onStart(f)}>
                        send assert request
                      </button>
                      <button type="button" className="danger" onClick={() => unfriend(a)}>
                        unfriend
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="friends-empty">
              <h3>your circle is empty.</h3>
              <p>add someone you trust, then put something on the line.</p>
              <button type="button" className="small-blue" onClick={() => setAdding(true)}>+ add a friend</button>
            </div>
          )}
        </div>
      </section>
      {followedIds.length ? (
        <section className="followed-section">
          <div className="section-head clean">
            <h2 className="section-title">followed asserts</h2>
          </div>
          {followedIds.map((goalId) => (
            <GoalCard
              key={goalId}
              id={goalId}
              profiles={profiles}
              readOnly={readOnly}
              followed
              compact
              onToggleFollow={onToggleFollow}
            />
          ))}
        </section>
      ) : null}
      {feed.length ? (
        <section className="social-feed-section">
          <div className="section-head clean">
            <h2 className="section-title">recent activity</h2>
          </div>
          <SocialFeed rows={feed.slice(0, 4)} />
        </section>
      ) : null}
    </div>
  );
}

function RefereeRequestNotices({
  goals,
  profiles,
  onDenied,
  onViewFriends,
}: {
  goals: CreatedArgs[];
  profiles: Record<string, UserProfile>;
  onDenied: (denial: StoredRefereeDenial) => void;
  onViewFriends: () => void;
}) {
  const { writeContractAsync, isPending } = useWriteContract();
  const [error, setError] = useState('');
  const accept = async (g: CreatedArgs) => {
    const addressFor = g.source === 'v2' ? COMMITMENT_V2_ADDRESS : COMMITMENT_ADDRESS;
    const abiFor = g.source === 'v2' ? commitmentV2Abi : commitmentAbi;
    const h = await writeContractAsync({ chainId: base.id, address: addressFor, abi: abiFor, functionName: 'acceptRole', args: [g.id], gas: ACCEPT_ROLE_GAS });
    await waitForTx(h);
    window.location.reload();
  };
  const deny = async (goal: CreatedArgs) => {
    setError('');
    try {
      const denial = await saveRefereeDenial({
        goal_id: goalKey(goal.id, goal.source),
        creator_wallet: goal.creator,
        referee_wallet: goal.referee,
      });
      onDenied(denial);
    } catch {
      setError('could not notify them yet. try again in friends.');
    }
  };
  if (!goals.length) return null;
  return (
    <section className="app-notices" aria-label="assert notifications">
      {error ? <p className="friend-add-error">{error}</p> : null}
      {goals.map((g) => {
        const { title } = splitGoalText(g.goalText);
        return (
          <div className="friend-card-wrap request-card" key={`request-${goalKey(g.id, g.source)}`}>
            <div className="friend-card">
              <MiniAvatar name={profileName(g.creator, profiles)} />
              <div>
                <h3>{profileName(g.creator, profiles)} called you in</h3>
                <p>{title}</p>
                <b>{fmtAmount(g.amount, g.source, 3)} {unitOf(g.source)} waiting on you</b>
              </div>
            </div>
            <div className="friend-bubble request-actions" role="group">
              <button type="button" className="btn green" onClick={() => accept(g)} disabled={isPending}>
                {isPending ? 'accepting…' : 'accept role'}
              </button>
              <a href={`#g/${goalKey(g.id, g.source)}`} className="btn ghost view-assert">view assert →</a>
              <button type="button" className="btn ghost" onClick={() => deny(g)} disabled={isPending}>
                deny request
              </button>
              <button type="button" className="btn ghost" onClick={onViewFriends}>
                friends tab
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function DeniedRequests({ goals, profiles }: { goals: CreatedArgs[]; profiles: Record<string, UserProfile> }) {
  const { writeContractAsync, isPending } = useWriteContract();
  const cancel = async (g: CreatedArgs) => {
    const addressFor = g.source === 'v2' ? COMMITMENT_V2_ADDRESS : COMMITMENT_ADDRESS;
    const abiFor = g.source === 'v2' ? commitmentV2Abi : commitmentAbi;
    const h = await writeContractAsync({ chainId: base.id, address: addressFor, abi: abiFor, functionName: 'cancel', args: [g.id] });
    await waitForTx(h);
    window.location.reload();
  };
  if (!goals.length) return null;
  return (
    <section className="denial-notices" aria-label="denied assert requests">
      {goals.map((g) => {
        const { title } = splitGoalText(g.goalText);
        return (
          <div className="friend-card-wrap request-card denial-card" key={`denied-${goalKey(g.id, g.source)}`}>
            <div className="friend-card">
              <MiniAvatar name={profileName(g.referee, profiles)} />
              <div>
                <h3>{profileName(g.referee, profiles)} denied this assert</h3>
                <p>{title}</p>
                <b>{fmtAmount(g.amount, g.source, 3)} {unitOf(g.source)} ready to refund</b>
              </div>
            </div>
            <div className="friend-bubble request-actions" role="group">
              <button type="button" className="btn green" onClick={() => cancel(g)} disabled={isPending}>
                {isPending ? 'cancelling…' : 'cancel · refund'}
              </button>
              <a href={`#g/${goalKey(g.id, g.source)}`} className="btn ghost view-assert">view assert →</a>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function ProfileTab({
  myGoals,
  profile,
  address,
  onSave,
}: {
  myGoals: CreatedArgs[];
  profile: UserProfile;
  address?: `0x${string}`;
  onSave: (profile: UserProfile) => void;
}) {
  const goals = useGoalsByIds(myGoals);
  const won = goals.filter((g) => g?.[6] === 2).length;
  const bailed = goals.filter((g) => g?.[6] === 3).length;
  const finished = won + bailed;
  const completion = finished ? `${Math.round((won / finished) * 100)}%` : '—';
  const toUnits = (w: bigint, src: GoalSource) => Number(formatUnits(w, src === 'v2' ? 6 : 18));
  const kept = goals.reduce(
    (sum, g, i) => sum + (g && g[6] === 2 ? toUnits(g[3], myGoals[i]?.source ?? 'v1') : 0),
    0,
  );
  const lost = goals.reduce(
    (sum, g, i) => sum + (g && g[6] === 3 ? toUnits(g[3], myGoals[i]?.source ?? 'v1') - toUnits(g[4], myGoals[i]?.source ?? 'v1') : 0),
    0,
  );
  const keptUnit = myGoals.some((g) => g.source === 'v2') ? 'USDC' : 'ETH';
  const lostUnit = keptUnit;
  const history = myGoals
    .map((g, i) => ({ goal: g, st: goals[i]?.[6] }))
    .filter((h) => h.st === 2 || h.st === 3 || h.st === 4)
    .reverse()
    .slice(0, 4);
  const [username, setUsername] = useState(profile.username);
  const [pfpUrl, setPfpUrl] = useState(profile.pfpUrl);
  const profileChanged = username.trim() !== profile.username || pfpUrl.trim() !== profile.pfpUrl;
  const saveProfile = () => onSave({ username: username.trim() || short(address, 3) || 'you', pfpUrl: pfpUrl.trim(), locked: true });
  const uploadPfp = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setPfpUrl(typeof reader.result === 'string' ? reader.result : pfpUrl);
    reader.readAsDataURL(file);
  };
  return (
    <div className="social-app">
      <section className="profile-card">
        <div className="profile-top">
          <ProfileAvatar profile={{ ...profile, username, pfpUrl }} />
          <div>
            <span className="eyebrow">{profile.locked ? 'locked profile' : 'set your profile'}</span>
            <h2>{profile.locked ? profile.username : 'claim your name'}</h2>
            <p>{short(address ?? myGoals[0]?.creator ?? '0xA8EaF49c1c33F987eFE883FdE72d4a1c243fB9EC')}</p>
          </div>
        </div>
        <div className="profile-editor">
          <label>
            username
            <input value={username} maxLength={24} placeholder="sillyboi" onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="pfp-upload-label">
            pfp
            <input type="file" accept="image/*" onChange={(e) => uploadPfp(e.target.files?.[0])} />
            <span>upload image</span>
          </label>
          <button className="btn-primary" type="button" onClick={saveProfile} disabled={!profileChanged && profile.locked}>
            {profile.locked ? 'update profile' : 'lock it in'}
          </button>
        </div>
        <div className="profile-stats">
          <div><span>won</span><b>{won}</b></div>
          <div><span>completion</span><b>{completion}</b></div>
          <div><span>kept</span><b>{kept ? `${kept.toFixed(2)} ${keptUnit}` : `0 ${keptUnit}`}</b></div>
          <div><span>lost</span><b>{lost ? `${lost.toFixed(2)} ${lostUnit}` : `0 ${lostUnit}`}</b></div>
        </div>
      </section>
      <section className="tab-shell">
        <div className="section-head clean">
          <h2 className="section-title">recent history</h2>
        </div>
        {history.length ? (
          history.map(({ goal: g, st }) => (
            <div className="history-row" key={goalKey(g.id, g.source)}>
              <span>{st === 2 ? 'WON' : st === 3 ? 'FOLDED' : 'CANCELLED'}</span>
              <p>{g.goalText}</p>
            </div>
          ))
        ) : (
          <p className="empty-copy">no finished asserts — no history yet.</p>
        )}
        <WalletSettings />
      </section>
    </div>
  );
}

function DisciplineHome({
  myGoals,
  statuses,
  feed,
  friendCount,
  profiles = {},
  contacts = [],
  onStart,
  onViewAsserts,
  onViewActivity,
}: {
  myGoals: CreatedArgs[];
  statuses: (GoalStruct | undefined)[];
  feed: SocialFeedItem[];
  friendCount: number;
  profiles?: Record<string, UserProfile>;
  contacts?: `0x${string}`[];
  onStart: () => void;
  onViewAsserts: () => void;
  onViewActivity: () => void;
}) {
  const feedEmpty = feed.length === 0;
  const livePairs = myGoals
    .map((g, i) => ({ g, st: statuses[i]?.[6] }))
    .filter(({ st }) => st === 0 || st === 1);
  const active = livePairs.length;
  const ethAtRisk = livePairs.reduce((sum, { g }) => sum + (g.source === 'v1' ? Number(formatEther(g.amount)) : 0), 0);
  const usdcAtRisk = livePairs.reduce((sum, { g }) => sum + (g.source === 'v2' ? Number(formatUnits(g.amount, 6)) : 0), 0);
  const ethPriceUsd = useEthPriceUsd();
  const usdValue = ethAtRisk * (ethPriceUsd ?? 0) + usdcAtRisk;
  const atRiskLabel =
    usdValue > 0
      ? `$${usdValue.toFixed(2)}`
      : ethAtRisk > 0 && ethPriceUsd == null
        ? `${ethAtRisk.toFixed(3).replace(/\.?0+$/, '')} ETH`
        : usdcAtRisk > 0
          ? `${usdcAtRisk.toFixed(2).replace(/\.?0+$/, '')} USDC`
          : '0';
  const friendsActive = feed.filter((item) => item.who !== 'you' && (item.badge === 'live' || item.badge === 'day'));
  const activity = feed.filter((item) => item.badge === 'won' || item.badge === 'folded');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="social-app">
      <section className="home-overview">
        <img className="home-wordmark" src="/wordmark.png" alt="Assert" />
        <div className="home-overview-head">
          <h2>
            {active ? `you've got ${active} assert${active === 1 ? '' : 's'} on the line.` : 'nothing on the line yet.'}
          </h2>
          <button className="home-overview-add" onClick={onStart} aria-label="create assert">+</button>
        </div>
        <div className="home-overview-stats">
          <div className="home-stat">
            <b>{active}</b>
            <span>active</span>
          </div>
          <div className="home-stat">
            <b>{atRiskLabel || '0'}</b>
            <span>at stake</span>
          </div>
          <div className="home-stat">
            <b>{friendCount || '0'}</b>
            <span>friend{friendCount === 1 ? '' : 's'} watching</span>
          </div>
        </div>
      </section>

      {livePairs.length ? (
        <section className="home-active-zone">
          <div className="home-section-head">
            <h3 className="home-section-title">active asserts</h3>
            <button className="tiny-link" type="button" onClick={onViewAsserts}>view all</button>
          </div>
          <div className="home-active-list">
            {livePairs.map(({ g, st }) => {
              const key = goalKey(g.id, g.source);
              const isOpen = expanded.has(key);
              return (
                <div key={key} className={`home-active-item${isOpen ? ' open' : ''}`}>
                  <HomeAssertCard goal={g} status={st ?? 0} profiles={profiles} compact={!isOpen} isOpen={isOpen} onToggle={() => toggle(key)} />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {!feedEmpty && ((friendsActive.length > 0 && myGoals.length > 0) || !livePairs.length) ? (
        <section className="home-friends-zone">
          <div className="home-section-head">
            <span className="home-eyebrow">people</span>
            <h3 className="home-section-title">friends are pushing</h3>
            <button className="tiny-link" type="button" onClick={onViewActivity}>see all</button>
          </div>
          <div className="home-friends-scroll">
            {friendsActive.length
              ? friendsActive.map((item) => (
                  <div className="home-friend-chip" key={`${item.who}-${item.body}`}>
                    {item.pfp ? (
                      <img className="mini-avatar" src={item.pfp} alt={item.who} />
                    ) : (
                      <span className="mini-avatar">{item.who[0]}</span>
                    )}
                    <div>
                      <b>{item.who}</b>
                      <p>{item.body}</p>
                    </div>
                    <span className="home-friend-live">live</span>
                  </div>
                ))
              : null}
            {!friendsActive.length && contacts.length ? (
              <p className="empty-copy">nobody is mid-assert right now.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="home-feed-zone">
        <div className="home-section-head">
          <h3 className="home-section-title">recent activity</h3>
          <button className="tiny-link" type="button" onClick={onViewActivity}>see all →</button>
        </div>
        <SocialFeed rows={(activity.length === 0 ? feed : [...friendsActive, ...activity]).slice(0, 4)} />
      </section>
    </div>
  );
}

function WalletSettings() {
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  return (
    <div className="wallet-settings">
      <span>connected wallet</span>
      <b>{short(address)}</b>
      <button className="btn ghost" onClick={() => disconnect()}>disconnect</button>
    </div>
  );
}

function NavHomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 11l8-6.5L20 11" />
      <path d="M6 9.5V19h12V9.5" />
    </svg>
  );
}

function NavAssertsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v3M12 20v3M1 12h3M20 12h3" />
    </svg>
  );
}

function NavFriendsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M17 14.5c2.5 0 3.5 2 3.7 4" />
    </svg>
  );
}

function NavYouIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5" />
    </svg>
  );
}

function BottomNav({ active, onSelect, pending }: { active: AppMode; onSelect: (mode: AppMode) => void; pending?: number }) {
  const items: { label: string; mode: AppMode; Icon: () => React.ReactNode }[] = [
    { label: 'Home', mode: 'home', Icon: NavHomeIcon },
    { label: 'Asserts', mode: 'asserts', Icon: NavAssertsIcon },
    { label: 'Friends', mode: 'friends', Icon: NavFriendsIcon },
    { label: 'You', mode: 'you', Icon: NavYouIcon },
  ];
  return (
    <nav className="bottom-nav" aria-label="app navigation">
      {items.slice(0, 2).map((item) => {
        const isActive = active === item.mode;
        return (
          <button
            key={item.mode}
            className={`nav-item${isActive ? ' active' : ''}`}
            onClick={() => onSelect(item.mode)}
          >
            <span className="nav-icon">
              <item.Icon />
            </span>
            {isActive ? <span className="nav-label">{item.label}</span> : null}
            {item.mode === 'friends' && pending ? <span className="nav-badge">{pending > 9 ? '9+' : pending}</span> : null}
          </button>
        );
      })}
      <button className="nav-plus" onClick={() => onSelect('builder')} aria-label="create assert">+</button>
      {items.slice(2).map((item) => {
        const isActive = active === item.mode;
        return (
          <button
            key={item.mode}
            className={`nav-item${isActive ? ' active' : ''}`}
            onClick={() => onSelect(item.mode)}
          >
            <span className="nav-icon">
              <item.Icon />
            </span>
            {isActive ? <span className="nav-label">{item.label}</span> : null}
            {item.mode === 'friends' && pending ? <span className="nav-badge">{pending > 9 ? '9+' : pending}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

/* ---------------- share invite ---------------- */

function ShareInvite({ id, referee: fallbackReferee, onClose }: { id: string; referee: string; onClose: () => void }) {
  const { source, id: rawId } = splitGoalKey(id);
  const contract = source === 'v2' ? COMMITMENT_V2_ADDRESS : COMMITMENT_ADDRESS;
  const abi = source === 'v2' ? commitmentV2Abi : commitmentAbi;
  const link = `${window.location.origin}${window.location.pathname}#g/${id}`;
  const [copied, setCopied] = useState(false);
  const { data } = useReadContract({
    chainId: base.id,
    address: contract,
    abi,
    functionName: 'goals',
    args: [rawId],
  });
  const raw = source === 'v2' && COMMITMENT_V2_ADDRESS !== ZERO_ADDRESS ? (data ? v2ToGoalStruct(data as GoalStructV2) : undefined) : data as GoalStruct | undefined;
  const referee = (raw?.[1] as string | undefined) || fallbackReferee || '';
  const amount = raw?.[3];
  const title = splitGoalText(raw?.[2] ?? 'my assert').title;
  const hasReferee = referee.startsWith('0x') && referee !== '0x0';
  const unit = unitOf(source);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-locked"
        role="dialog"
        aria-label="assert locked in"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="close">×</button>
        <div className="locked-badge">✓</div>
        <h2 className="locked-title"><b className="locked-gradient">LOCKED IN</b></h2>
        <p className="modal-sub locked-line fade-up fade-up-1">
          {amount !== undefined ? (
            <>
              You staked <b>{fmtAmount(amount, source, 3)} {unit}</b> into contract{' '}
              <b title={contract}>{short(contract, 6)}</b> on Base.{' '}
            </>
          ) : null}
          <span className="muted">2% fee only applies when it resolves.</span>
        </p>
        <p className="modal-sub locked-line fade-up fade-up-2">
          {hasReferee ? (
            <>
              When <b title={referee}>{short(referee as `0x${string}`, 6)}</b> accepts this link, they hold the
              outcome.
            </>
          ) : (
            <>Share this link so your referee can accept.</>
          )}
        </p>
        <div className="share-box fade-up fade-up-3">
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button
            className={`btn-primary${copied ? ' copied' : ''}`}
            onClick={() => {
              navigator.clipboard?.writeText(link).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
        </div>
        {amount !== undefined ? (
          <a
            className="btn-primary share-x-button fade-up fade-up-4"
            href={assertShareHref({ id: rawId, title, amount, status: 0, source })}
            target="_blank"
            rel="noreferrer"
          >
            <ShareOnXLabel />
          </a>
        ) : null}
        <p className="invite-copy muted fade-up fade-up-4" style={{ marginTop: 14 }}>
          or have them open <b>this app</b> — the assert will already show in their referee view.
        </p>
      </div>
    </div>
  );
}

/* ---------------- goal card ---------------- */

function GoalCard({
  id,
  only,
  focused,
  profiles = {},
  fallback,
  readOnly = false,
  followed = false,
  compact = false,
  onToggleFollow,
}: {
  id: string;
  only?: AssertFilter;
  focused?: boolean;
  profiles?: Record<string, UserProfile>;
  fallback?: { goal: CreatedArgs; status: number };
  readOnly?: boolean;
  followed?: boolean;
  compact?: boolean;
  onToggleFollow?: (id: bigint | string) => void;
}) {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const { source: idSource, id: rawId } = splitGoalKey(id);
  const source = fallback?.goal.source ?? idSource;
  const addressFor = source === 'v2' ? COMMITMENT_V2_ADDRESS : COMMITMENT_ADDRESS;
  const abiFor = source === 'v2' ? commitmentV2Abi : commitmentAbi;
  const { data } = useReadContract({
    chainId: base.id,
    address: addressFor,
    abi: abiFor,
    functionName: 'goals',
    args: [rawId],
  });
  const raw = fallback ? toGoalStruct(fallback.goal, fallback.status) : data && source === 'v2' && COMMITMENT_V2_ADDRESS !== ZERO_ADDRESS ? v2ToGoalStruct(data as GoalStructV2) : data as GoalStruct | undefined;
  const { out, expired } = useCountdown(raw?.[5]);
  const { expired: graceOver } = useCountdown(raw?.[5] !== undefined ? raw[5] + 172800n : 0n);
  if (!raw) return null;

  const [creator, referee, goalText, amount, feeAmount, , status] = raw;
  if (only) {
    const matches =
      only === 'Live'
        ? status === 1
        : only === 'Pending'
          ? status === 0
          : only === 'Won'
            ? status === 2
            : only === 'Bailed'
              ? status === 3
              : false;
    if (!matches) return null;
  }
  const isCreator = address === creator;
  const isReferee = address === referee;
  const refund = amount - feeAmount;
  const { title, description } = splitGoalText(goalText);

  const run = async (functionName: 'acceptRole' | 'approve' | 'cancel' | 'claimReferee' | 'forfeit' | 'refundNoShow') => {
    const hash = await writeContractAsync({
      chainId: base.id,
      address: addressFor,
      abi: abiFor,
      functionName,
      args: [rawId],
      ...(functionName === 'acceptRole' ? { gas: ACCEPT_ROLE_GAS } : {}),
    });
    await waitForTx(hash);
    window.location.reload();
  };

  return (
    <div className={`card goal assert-detail-card fade-up-1${status === 1 ? ' live' : ''}${isReferee ? ' referee' : ''}${compact ? ' compact' : ''}`}>
      <div className="goal-top assert-pass-top">
        <span className="goal-tags">
          <span className={`status s${status}`}>{STATUS_LABEL[status]}</span>
          {isReferee && (
            <span className="referee-tag">
              <span className="referee-tag-dot" />
              you're the referee
            </span>
          )}
        </span>
        <b>{fmtAmount(amount, source)} {unitOf(source)}</b>
      </div>
      <p className="goal-text">{title}</p>
      {focused && description && !compact ? <p className="goal-desc">{description}</p> : null}
      {!focused ? <a className="goal-open" href={`#g/${id}`}>view assert →</a> : null}
      {!compact ? <div className="home-assert-state">
        <ClockIcon />
        <div>
          {status === 0 ? (
            <>
              <span className="state-line">Waiting on {isReferee ? 'you' : profileName(referee, profiles)}.</span>
              <span className="state-sub">Referee must accept to activate the assert.</span>
            </>
          ) : status === 1 ? (
            <>
              <span className="state-line">{isReferee ? `you're watching ${profileName(creator, profiles)}` : `${profileName(referee, profiles)} is watching you`}</span>
              <span className="state-sub">
                {graceOver
                  ? 'referee never called it — stake returned.'
                  : expired
                    ? 'time is up · referee has 2 days to call it'
                    : `${out} left`} · {isReferee ? `you take ${fmtAmount(amount, source)} ${unitOf(source)} if they bail` : `${profileName(referee, profiles)} takes ${fmtAmount(amount, source)} ${unitOf(source)} if you bail`}
              </span>
            </>
          ) : status === 2 ? (
            <>
              <span className="state-line">Honored — stake returned</span>
              <span className="state-sub">{isCreator ? 'you' : profileName(creator, profiles)} kept their word.</span>
            </>
          ) : status === 3 ? (
            <>
              <span className="state-line">Missed — {isReferee ? 'you' : profileName(referee, profiles)} earned it</span>
              <span className="state-sub">Referee collected the stake.</span>
            </>
          ) : (
            <>
              <span className="state-line">Cancelled — full refund</span>
              <span className="state-sub">Assert voided — stake returned in full.</span>
            </>
          )}
        </div>
      </div> : null}
      {!compact && (status === 0 || status === 1) && (
        <div className="outcome-split">
          <div className="outcome win">
            <span>you hit it</span>
            <b>{fmtAmount(refund, source)} {unitOf(source)} back</b>
          </div>
          <div className="outcome lose">
            <span>you miss</span>
            <b>{fmtAmount(refund, source)} {unitOf(source)} to referee</b>
          </div>
          <div className="outcome fee">protocol fee {fmtAmount(feeAmount, source)} {unitOf(source)} ({Number((feeAmount * 10000n) / amount)} bps)</div>
        </div>
      )}
      {(status === 0 || status === 1) && (
        <div className="assert-risk-strip detail-risk-strip">
          <span>Bail → {isReferee ? 'you' : profileName(referee, profiles)} gets {fmtAmount(refund, source)} {unitOf(source)}</span>
        </div>
      )}
      <div className="goal-actions">
        {isCreator ? (
          <a
            className="btn ghost share-x-action"
            href={assertShareHref({ id: rawId, title, amount, status, source })}
            target="_blank"
            rel="noreferrer"
          >
            <ShareOnXLabel />
          </a>
        ) : null}
        {onToggleFollow ? (
          <button
            className={`btn ghost follow-toggle${followed ? ' following' : ''}`}
            onClick={() => onToggleFollow(id)}
          >
            {followed ? '★ following' : '☆ follow'}
          </button>
        ) : null}
        {compact ? null : readOnly ? (
          <span className="muted">local preview only — no wallet or money needed</span>
        ) : (
          <>
        {status === 0 && isReferee && (
          <button className="btn green" onClick={() => run('acceptRole')} disabled={isPending}>
            ✓ yes, I'll referee
          </button>
        )}
        {status === 0 && isCreator && (
          <button className="btn ghost" onClick={() => run('cancel')} disabled={isPending}>
            cancel · refund
          </button>
        )}
        {status === 1 && isReferee && !graceOver && (
          <button className="btn green" onClick={() => run('approve')} disabled={isPending}>
            ✓ they did it
          </button>
        )}
        {status === 1 && expired && isReferee && !graceOver && (
          <button className="btn red" onClick={() => run('claimReferee')} disabled={isPending}>
            referee earns stake
          </button>
        )}
        {status === 1 && expired && isCreator && !graceOver && (
          <button className="btn ghost" onClick={() => run('forfeit')} disabled={isPending}>
            I missed it — pay out
          </button>
        )}
        {status === 1 && graceOver && isCreator && (
          <button className="btn ghost" onClick={() => run('refundNoShow')} disabled={isPending}>
            reclaim stake · referee no-show
          </button>
        )}
        {status === 1 && graceOver && !isCreator && (
          <span className="muted">2-day window closed — stake returned to creator</span>
        )}
        {status === 2 && <span className="muted">✓ honored — stake returned</span>}
        {status === 3 && <span className="muted">✗ humbled — referee earned it</span>}
        {status === 4 && <span className="muted">cancelled — full refund</span>}
        {status === 1 && !isReferee && !expired && (
          <span className="muted">locked in — waiting on deadline</span>
        )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- landing ---------------- */

type LegalSection = { heading: string; paras: string[] };

const LEGAL: Record<'terms' | 'privacy', { eyebrow: string; title: string; updated: string; sections: LegalSection[] }> = {
  terms: {
    eyebrow: 'terms & conditions',
    title: 'the terms.',
    updated: 'last updated: september 2026',
    sections: [
      {
        heading: '1. you\'re making a promise',
        paras: [
          'Assert lets you stake money on commitments you make to yourself while a friend you pick acts as referee. By creating or refereeing a commitment you agree to these terms and to use Assert only for lawful purposes.',
          'This is a game of accountability, not a store of value, an investment product, or financial advice. We make no promise that you will keep your commitments — that is the whole point.',
        ],
      },
      {
        heading: '2. who can use it',
        paras: [
          'You must be at least 18 years old and legally able to enter into binding agreements. You may not use Assert in any jurisdiction where doing so is prohibited.',
        ],
      },
      {
        heading: '3. your stake is real',
        paras: [
          'When you assert a goal, your stake is locked onchain and is not refundable. If you hit your commitment your stake and your referee\'s stake are returned. If you miss, the pot is paid out as the rules you agreed to when you created the commitment. When a commitment ends, the referee has a two-day window to call the outcome; if they never call it, your stake is returned.',
          'Transactions on Base cannot be reversed. Double-check every goal, amount, deadline and referee before you sign — there are no takebacks, by design.',
          'The app runs on the Base network. Stakes carry real value and the same no-takebacks rule applies.',
        ],
      },
      {
        heading: '4. referees judge',
        paras: [
          'A referee is a person you choose, and their call on whether a commitment was met is final. We are not your referee and we cannot override, review or reverse a referee\'s decision. Pick someone you trust to be honest.',
        ],
      },
      {
        heading: '5. no guarantees, experimental software',
        paras: [
          'The Assert contracts are experimental and provided "as is" without warranty of any kind, express or implied. Smart contracts, chains and apps can contain bugs, be exploited, or be interrupted.',
          'You use Assert entirely at your own risk. To the maximum extent permitted by law, we accept no liability for any loss — including lost stakes, lost funds, or indirect or consequential loss — arising from your use of the app.',
        ],
      },
      {
        heading: '6. things you can\'t do',
        paras: [
          'No illegal, abusive, fraudulent or harmful use. No cheating, colluding with your referee to rig outcomes, or harassing other users. We may refuse service or restrict access to anyone breaching these terms.',
        ],
      },
      {
        heading: '7. changes & governance',
        paras: [
          'We may update these terms at any time. Continued use of Assert after changes means you accept them. The deployed contracts are governed by their immutable code — what the code does, the code does.',
        ],
      },
      {
        heading: '8. talk to us',
        paras: [
          'Questions about these terms? Reach us through the site at https://useassert.app.',
        ],
      },
    ],
  },
  privacy: {
    eyebrow: 'privacy policy',
    title: 'the privacy policy.',
    updated: 'last updated: september 2026',
    sections: [
      {
        heading: '1. short version',
        paras: [
          'We barely collect anything. Assert is a smart-contract app: your wallet connects directly to the Base network and almost everything lives on the public blockchain, not on our servers.',
        ],
      },
      {
        heading: '2. what we do collect',
        paras: [
          'Your wallet address (so the app can show you your commitments and profile), a username and optional profile picture you choose, your dismissed-request and hidden-friend preferences, and onchain data — goals, stakes and referee decisions — which is public by the nature of blockchain.',
          'When you\'re connected, your profile and preferences are synced over HTTPS to a hosted database (our Supabase project) keyed by your wallet address so they follow you across devices. A copy also lives in your browser\'s local storage.',
        ],
      },
      {
        heading: '3. what we don\'t collect',
        paras: [
          'No email, no phone number, no name, no ID, no KYC, no location tracking, and no cookies that follow you around. We do not sell data. We do not advertise.',
        ],
      },
      {
        heading: '4. when you send a transaction',
        paras: [
          'Your wallet sends transactions to the Base network, which may involve third-party RPC providers and wallet providers (such as Coinbase Wallet or WalletConnect). Those services have their own privacy policies and handle your data as needed to route your transactions.',
        ],
      },
      {
        heading: '5. blockchain is public',
        paras: [
          'Everything you do onchain is permanently and publicly visible to anyone: your wallet address, your goals, your stakes and the outcome of each commitment. Do not assert anything you wouldn\'t be comfortable having public.',
        ],
      },
      {
        heading: '6. where your profile lives',
        paras: [
          'Your profile and preferences are stored both in your browser\'s local storage and, when you\'re connected, in a hosted database keyed by your wallet address so your name, avatar, dismissed requests and hidden friends follow you across devices.',
          'Clearing your browser\'s site data removes the local copy. The hosted copy is keyed to your wallet; if you want it gone, delete the row for your address in the database or contact us.',
          'Note: the hosted copy is served over the internet for sync purposes, so treat your username and avatar as semi-public — don\'t store anything sensitive there. Only what you put onchain is broadcast to other users.',
        ],
      },
      {
        heading: '7. kids',
        paras: [
          'Assert is not for anyone under 18, and we ask that minors not use it. Do not assert a goal if it may put personal data about someone else onchain without their consent.',
        ],
      },
      {
        heading: '8. changes & contact',
        paras: [
          'We may update this policy from time to time; the date above reflects the latest version. Questions? Reach us through the site at https://useassert.app.',
        ],
      },
    ],
  },
};

function LegalPage({ route }: { route: keyof typeof LEGAL }) {
  const content = LEGAL[route];
  return (
    <div className="page page-legal">
      <div className="aurora" aria-hidden="true" />
      <header className="legal-top">
        <img className="brand-wordmark legal-wordmark" src="/wordmark.png" alt="Assert" />
        <a className="legal-back" href="#/">← back</a>
      </header>
      <main className="legal-content">
        <p className="legal-eyebrow">{content.eyebrow}</p>
        <h1>{content.title}</h1>
        <p className="legal-updated">{content.updated}</p>
        {content.sections.map((s) => (
          <section key={s.heading}>
            <h2>{s.heading}</h2>
            {s.paras.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
      </main>
      <footer className="legal-bottom">Assert · built on Base · <a href="#/">back home</a></footer>
    </div>
  );
}

/* ---------------- app ---------------- */

export default function App() {
  const account = useAccount();
  const isMock = import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1';
  const previewAddress = useMemo(() => {
    if (!import.meta.env.DEV) return undefined;
    const value = new URLSearchParams(window.location.search).get('preview');
    if (!value) return undefined;
    try {
      return getAddress(value);
    } catch {
      return undefined;
    }
  }, []);
  const isPreview = Boolean(previewAddress) || isMock;
  const isConnected = account.isConnected || isPreview;
  const chainId = account.chainId ?? (isPreview ? base.id : undefined);
  const address = isMock ? MOCK_ADDRESS : previewAddress ?? account.address;
  const { signMessageAsync } = useSignMessage();
  const [appMode, setAppMode] = useState<AppMode>(() => {
    if (import.meta.env.DEV && (new URLSearchParams(window.location.search).has('preview') || new URLSearchParams(window.location.search).get('mock') === '1')) return 'home';
    const saved = localStorage.getItem('assert-app-mode');
    return saved === 'home' || saved === 'asserts' || saved === 'builder' || saved === 'friends' || saved === 'you'
      ? saved
      : 'intro';
  });
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>(readProfiles);
  const [refereeDenials, setRefereeDenials] = useState<StoredRefereeDenial[]>([]);
  const [draftReferee, setDraftReferee] = useState<string | undefined>();
  const [followedIds, setFollowedIds] = useState<string[]>(() => (address ? readFollowed(address) : []));
  useEffect(() => {
    if (address) setFollowedIds(readFollowed(address));
  }, [address]);
  const toggleFollow = (id: bigint | string) => {
    const value = id.toString();
    if (!address) return;
    const next = followedIds.includes(value) ? followedIds.filter((v) => v !== value) : [...followedIds, value];
    setFollowedIds(next);
    localStorage.setItem(FOLLOWED_KEY(address), JSON.stringify(next));
    readStoredPreferences(address)
      .then((stored) =>
        saveStoredPreferences({
          wallet_address: address,
          dismissed_request_ids: stored?.dismissed_request_ids ?? [],
          hidden_friend_addresses: stored?.hidden_friend_addresses ?? [],
          followed_goal_ids: next,
        }),
      )
      .catch((error) => console.warn('Supabase preferences sync failed', error));
  };
  const onKnownChain = isPreview || chainId === 8453 || chainId === 84532;
  const { data: chainGoals } = useAllCreated();
  const allGoals = isMock ? MOCK_GOALS : chainGoals;
  useEffect(() => {
    if (!address || !hasSupabase || isPreview) {
      setMintHook(null);
      if (!isPreview) clearAuthToken();
      return;
    }
    const wallet = address as `0x${string}`;
    setMintHook(() => mintAuthToken((message) => signMessageAsync({ message }), wallet));
    ensureAuthToken().catch((error) => console.warn('Supabase auth failed', error));
    return () => {
      setMintHook(null);
    };
  }, [address, isPreview, signMessageAsync]);
  const profile = address ? profiles[address] ?? defaultProfile(address) : defaultProfile();
  const saveProfile = (nextProfile: UserProfile) => {
    if (!address) return;
    const nextProfiles = { ...profiles, [address]: nextProfile };
    setProfiles(nextProfiles);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(nextProfiles));
    saveStoredProfile({
      wallet_address: address,
      username: nextProfile.username,
      pfp_url: nextProfile.pfpUrl,
      locked: nextProfile.locked,
    }).catch((error) => console.warn('Supabase profile save failed', error));
  };

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    readStoredProfile(address)
      .then((stored) => {
        if (!stored || cancelled) return;
        const nextProfile = {
          username: stored.username || short(address, 3),
          pfpUrl: stored.pfp_url,
          locked: stored.locked,
        };
        setProfiles((current) => {
          const nextProfiles = { ...current, [address]: nextProfile };
          localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(nextProfiles));
          return nextProfiles;
        });
      })
      .catch((error) => console.warn('Supabase profile load failed', error));
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    if (appMode === 'intro') return;
    localStorage.setItem('assert-app-mode', appMode);
  }, [appMode]);

  // deep link: #g/<id>
  const [inviteId, setInviteId] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(() => {
    return readDeepLinkedGoal();
  });
  useEffect(() => {
    const onHash = () => {
      setInvited(readDeepLinkedGoal());
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  const myGoals = (allGoals ?? []).filter(
    (g) => address && (g.creator === address || g.referee === address),
  );
  const chainMyStatuses = useGoalsByIds(myGoals);
  const myStatuses = isMock ? myGoals.map((g, i) => toGoalStruct(g, i === 0 ? 1 : 0)) : chainMyStatuses;
  useEffect(() => {
    if (!address || !hasSupabase) {
      setRefereeDenials([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      readRefereeDenials(address)
        .then((rows) => {
          if (!cancelled) setRefereeDenials(rows);
        })
        .catch((error) => console.warn('Supabase denial load failed', error));
    };
    load();
    const interval = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [address]);
  const deniedGoals = useMemo(() => {
    const rows = new Map(refereeDenials.map((d) => [d.goal_id, d]));
    return myGoals.filter((g, i) => {
      const row = rows.get(goalKey(g.id, g.source));
      return Boolean(
        address &&
        g.creator.toLowerCase() === address.toLowerCase() &&
        myStatuses[i]?.[6] === 0 &&
        row?.creator_wallet === g.creator.toLowerCase() &&
        row?.referee_wallet === g.referee.toLowerCase(),
      );
    });
  }, [address, myGoals, myStatuses, refereeDenials]);
  const deniedRequestIds = useMemo(() => {
    if (!address) return new Set<string>();
    return new Set(
      refereeDenials
        .filter((d) => d.referee_wallet === address.toLowerCase())
        .map((d) => d.goal_id),
    );
  }, [address, refereeDenials]);
  const refereeRequests = myGoals.filter(
    (g, i) => g.referee === address && myStatuses[i]?.[6] === 0 && !deniedRequestIds.has(goalKey(g.id, g.source)),
  );
  const addRefereeDenial = (denial: StoredRefereeDenial) => {
    setRefereeDenials((current) => {
      if (current.some((d) => d.goal_id === denial.goal_id)) return current;
      return [...current, denial];
    });
  };
  const contacts = useMemo(() => {
    const set = new Set<`0x${string}`>();
    for (const g of allGoals ?? []) {
      if (address && g.creator === address && g.referee !== address) set.add(g.referee);
      if (address && g.referee === address && g.creator !== address) set.add(g.creator);
    }
    return [...set];
  }, [allGoals, address]);
  const circleGoals = useMemo(() => {
    const isContact = new Set(contacts.map((c) => c.toLowerCase()));
    return (allGoals ?? []).filter((g) => {
      if (address && (g.creator === address || g.referee === address)) return true;
      return isContact.has(g.creator.toLowerCase()) || isContact.has(g.referee.toLowerCase());
    });
  }, [allGoals, contacts, address]);
  const circleStatuses = useGoalsByIds(circleGoals);
  const activeCircleStatuses = isMock ? circleGoals.map((g, i) => toGoalStruct(g, i === 0 ? 1 : 0)) : circleStatuses;
  const feed = activityFromGoals(circleGoals, activeCircleStatuses, {
    me: address,
    contacts: [...contacts],
    profiles,
  });
  const contactFriends: Friend[] = useMemo(
    () =>
      contacts.map((a) => ({
        name: profiles[a]?.username ?? short(a, 4),
        role: 'peer',
        record: '',
        detail: short(a, 6),
        pfp: profiles[a]?.pfpUrl ?? '',
        address: a,
      })),
    [contacts, profiles],
  );
  useEffect(() => {
    if (!address || contacts.length === 0) return;
    let cancelled = false;
    readStoredProfiles(contacts)
      .then((rows) => {
        if (cancelled || !rows.length) return;
        setProfiles((current) => {
          const next = { ...current };
          let changed = false;
          for (const row of rows) {
            try {
              const key = getAddress(row.wallet_address);
              const nextProfile = {
                username: row.username || short(key, 3),
                pfpUrl: row.pfp_url,
                locked: row.locked,
              };
              if (
                current[key]?.username !== nextProfile.username ||
                current[key]?.pfpUrl !== nextProfile.pfpUrl ||
                current[key]?.locked !== nextProfile.locked
              ) {
                next[key] = nextProfile;
                changed = true;
              }
            } catch {
              /* skip rows with unparseable wallets */
            }
          }
          if (changed) {
            localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(next));
            return next;
          }
          return current;
        });
      })
      .catch((error) => console.warn('Supabase contacts profile load failed', error));
    return () => {
      cancelled = true;
    };
  }, [address, contacts, appMode]);
  const invoked = invited ? (allGoals ?? []).find((g) => goalKey(g.id, g.source) === invited) : undefined;
  const invokedStatus = invoked ? myStatuses[myGoals.findIndex((g) => g.id === invoked.id && g.source === invoked.source)]?.[6] ?? 1 : 1;

  const [legalRoute, setLegalRoute] = useState<'terms' | 'privacy' | null>(() => {
    const m = window.location.hash.match(/^#\/(terms|privacy)$/);
    return m ? (m[1] as 'terms' | 'privacy') : null;
  });
  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(/^#\/(terms|privacy)$/);
      setLegalRoute(m ? (m[1] as 'terms' | 'privacy') : null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (legalRoute) return <LegalPage route={legalRoute} />;
  const startBuilder = (friend?: Friend) => {
    setDraftReferee(friend?.address);
    setAppMode('builder');
  };
  const startWithAddress = (address: `0x${string}`) =>
    startBuilder({
      name: short(address, 4),
      role: 'peer',
      record: '',
      detail: short(address, 6),
      pfp: '',
      address,
    });
  const selectMode = (mode: AppMode) => {
    if (mode === 'builder') setDraftReferee(undefined);
    if (invited || window.location.hash.startsWith('#g/')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setInvited(null);
    }
    setAppMode(mode);
  };

  return (
    <div className={`page${!isConnected ? ' landing-page' : ''}`}>
      {!isConnected ? (
        <EntryScene />
      ) : (
        <>
          <div className="aurora" aria-hidden="true" />
          <main>
          <RefereeRequestNotices
            goals={refereeRequests}
            profiles={profiles}
            onDenied={addRefereeDenial}
            onViewFriends={() => selectMode('friends')}
          />
          <DeniedRequests goals={deniedGoals} profiles={profiles} />
          {invited ? (
            <GoalCard id={invited} focused profiles={profiles} fallback={invoked ? { goal: invoked, status: invokedStatus } : undefined} readOnly={isMock} followed={followedIds.includes(invited)} onToggleFollow={toggleFollow} />
          ) : null}

          {invited ? null : appMode === 'intro' ? (
            <ConnectedIntro onStart={() => setAppMode('home')} profile={profile} />
          ) : appMode === 'builder' ? (
            <div className="create-screen">
              {isMock ? (
                <div className="banner action-warning">local mock mode is read-only — use the fake assert cards to test sharing.</div>
              ) : null}
              {!onKnownChain && (
                <div className="banner action-warning">switch to <b>base</b> before locking an assert.</div>
              )}
              <CreateWizard key={draftReferee ?? 'empty-referee'} initialReferee={draftReferee} contacts={contactFriends} onCreated={(key) => setInviteId(key !== '0' ? key : null)} />
            </div>
          ) : appMode === 'asserts' ? (
            <AssertsTab myGoals={myGoals} profiles={profiles} statuses={myStatuses} readOnly={isMock} />
          ) : appMode === 'friends' ? (
            <FriendsTab
              requests={refereeRequests}
              deniedGoals={deniedGoals}
              contacts={contacts}
              profiles={profiles}
              address={address}
              onStart={startBuilder}
              onAddFriend={startWithAddress}
              onDenied={addRefereeDenial}
              feed={feed}
              myGoals={myGoals}
              statuses={myStatuses}
              followedIds={followedIds}
              onToggleFollow={toggleFollow}
              readOnly={isMock}
            />
          ) : appMode === 'you' ? (
            <ProfileTab key={address} myGoals={myGoals} profile={profile} address={address} onSave={saveProfile} />
          ) : (
            <DisciplineHome
              myGoals={myGoals}
              statuses={myStatuses}
              feed={feed}
              friendCount={contacts.length}
              contacts={contacts}
              profiles={profiles}
              onStart={() => startBuilder()}
              onViewAsserts={() => selectMode('asserts')}
              onViewActivity={() => selectMode('friends')}
            />
          )}
          {inviteId ? (
            <ShareInvite
              id={inviteId}
              referee={invoked?.referee ?? ''}
              onClose={() => setInviteId(null)}
            />
          ) : null}
          {(appMode !== 'intro' || invited) && appMode !== 'builder' ? <BottomNav active={appMode} onSelect={selectMode} pending={refereeRequests.length + deniedGoals.length} /> : null}
          </main>
          {isConnected ? (
            <footer className="muted">
              assert — on your honor, onchain. ·{' '}
              <a className="legal-inline" href="#/terms">terms</a> ·{' '}
              <a className="legal-inline" href="#/privacy">privacy</a>
            </footer>
          ) : null}
        </>
      )}
    </div>
  );
}
