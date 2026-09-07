import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, getAbiItem, getAddress, http, parseUnits, formatEther } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import { commitmentAbi } from './Commitment.abi.ts';
import { COMMITMENT_ADDRESS, STATUS_LABEL } from './lib/wagmi.ts';
import { waitForTx } from './lib/tx.ts';
import {
  readStoredPreferences,
  readStoredProfile,
  saveStoredPreferences,
  saveStoredProfile,
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

type CreatedArgs = {
  id: bigint;
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

const short = (a: `0x${string}` | undefined, n = 4) =>
  a ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : '';
const fmt = (w: bigint) => (w === 0n ? '0' : Number(formatEther(w)).toFixed(3).replace(/\.?0+$/, ''));
const FEE_BPS = 200n; // 2% protocol fee, mirrors the live contract
const PROFILE_STORAGE_KEY = 'assert-profiles-v1';

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
  const out = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${String(s % 60).padStart(2, '0')}s`;
  return { out, urgent, expired: ms <= 0 };
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
    default:
      return { name: id ?? 'Wallet', initial: '•', color: 'var(--muted)' };
  }
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const { connect, connectors, isPending } = useConnect();
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
          {connectors.map((c) => {
            const meta = walletMeta(c.id);
            return (
              <button key={c.uid} className="wallet-row" onClick={() => connect({ connector: c })} disabled={isPending}>
                <span className="wallet-ico" style={{ background: meta.color }}>
                  {meta.initial}
                </span>
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
      {open && <ConnectModal onClose={() => setOpen(false)} />}
    </div>
  );
}

/* ---------------- data hook: all created goals ---------------- */

function useGoalsByIds(ids: bigint[]) {
  const { data } = useReadContracts({
    contracts: ids.map((id) => ({
      address: COMMITMENT_ADDRESS,
      abi: commitmentAbi,
      functionName: 'goals' as const,
      args: [id],
    })),
  });
  return (data ?? []).map((r) => r.result as GoalStruct | undefined);
}

function useAllCreated() {
  const createdEvent = getAbiItem({ abi: commitmentAbi, name: 'Created' });
  const publicClient = usePublicClient();
  const chainId = publicClient?.chain.id;
  return useQuery({
    queryKey: ['allCreated', chainId],
    queryFn: async () => {
      if (!publicClient) return [];
      // public base RPCs cap eth_getLogs at 10k-range windows, so we walk
      // backward from latest in chunks and stop at the deploy boundary
      const latest = await publicClient.getBlockNumber();
      const CHUNK = 9_900n; // RPC caps inclusive from..to at 10,000
      const MAX_CHUNKS = 40n; // ~396k blocks, way past the contract's young life
      const seen = new Map<string, CreatedArgs>();
      for (let i = 0n; i < MAX_CHUNKS; i++) {
        const to = latest - i * CHUNK;
        if (to <= 0n) break;
        const from = to - CHUNK < 0n ? 0n : to - CHUNK;
        const logs = await publicClient.getLogs({
          address: COMMITMENT_ADDRESS,
          event: createdEvent,
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        });
        for (const l of logs) {
          const a = l.args as CreatedArgs;
          seen.set(a.id.toString(), a);
        }
        // first empty chunk = created before this window; stop early
        if (logs.length === 0 && seen.size > 0) break;
      }
      return [...seen.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
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
}: {
  goal: string;
  setGoal: (v: string) => void;
}) {
  return (
    <div className="fade-up-1">
      <div className="builder-copy">
        <span className="eyebrow">new assert</span>
        <h3>what are you putting out there?</h3>
        <p className="muted">keep it simple. your friend should know exactly what counts.</p>
      </div>
      <label>
        promise
        <div className="textarea-shell">
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
      </label>
      <div className="template-grid">
        {ASSERT_TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            className="template-chip"
            onClick={() => {
              setGoal(t.goal);
            }}
          >
            <span>{t.label}</span>
            <b>{t.goal}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

function Step4Proof({ proof, setProof }: { proof: string; setProof: (v: string) => void }) {
  return (
    <div className="fade-up-1">
      <div className="builder-copy">
        <span className="eyebrow">proof</span>
        <h3>how does your friend verify it?</h3>
        <p className="muted">screenshots, check-ins, photos, links. make the call easy.</p>
      </div>
      <label className="proof-label">
        proof
        <div className="textarea-shell">
          <textarea
            className="goal-input proof-input"
            name="proof"
            maxLength={180}
            rows={2}
            placeholder="screenshots, check-ins, photos, a shipped link…"
            value={proof}
            onChange={(e) => setProof(e.target.value)}
          />
          <span className="char-count">{proof.length}/180</span>
        </div>
      </label>
    </div>
  );
}

function Step2Referee({
  value,
  onChange,
  onResolved,
  friends,
}: {
  value: string;
  onChange: (v: string) => void;
  onResolved: (addr: `0x${string}` | null) => void;
  friends: Friend[];
}) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const selectedFriend = friends.find((friend) => friend.address.toLowerCase() === value.trim().toLowerCase());

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
          alive && setResolved(addr ?? null);
          alive && onResolved((addr ?? null) as `0x${string}` | null);
        })
        .catch(() => alive && onResolved(null))
        .finally(() => alive && setResolving(false));
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
        <span className="eyebrow">friend</span>
        <h3>who calls it?</h3>
        <p className="muted">pick from your circle or paste a wallet. choose someone who won’t let you wiggle out.</p>
      </div>
      <label>
        choose a friend
        <div className="referee-picker-wrap">
          <button type="button" className="referee-picker-trigger" onClick={() => setShowFriends((open) => !open)}>
            {selectedFriend ? (
              <><MiniAvatar name={selectedFriend.name} src={selectedFriend.pfp} />{selectedFriend.name}</>
            ) : (
              <><MiniAvatar name="friend" />friends</>
            )}
          </button>
          <input
            name="referee"
            placeholder="friend.eth or 0x1234…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {showFriends ? (
            <div className="friend-bubble referee-bubble" role="menu">
              {friends.map((friend) => (
                <button
                  key={friend.name}
                  type="button"
                  onClick={() => {
                    onChange(friend.address);
                    setShowFriends(false);
                  }}
                >
                  <MiniAvatar name={friend.name} src={friend.pfp} />
                  <span><b>{friend.name}</b><small>{friend.role} · {friend.record}</small></span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </label>
      {resolving && <p className="ens-hint">resolving ens…</p>}
      {resolved && <p className="ens-hint">✓ resolved → {short(addr)}</p>}
      <div className="referee-suggest">
        <span>send it to someone who will actually call you out</span>
        <span>you'll get a link to share after you lock it in</span>
      </div>
      {value.trim() && !valid && !resolving && (
        <p className="muted" style={{ fontSize: 12 }}>
          that doesn't look like a valid wallet address yet
        </p>
      )}
    </div>
  );
}

function Step3Stake({
  stake,
  setStake,
  days,
  setDays,
  intensity,
  setIntensity,
}: {
  stake: string;
  setStake: (s: string) => void;
  days: number;
  setDays: (d: number) => void;
  intensity: string;
  setIntensity: (v: string) => void;
}) {
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
  const modes = [
    { name: 'soft mode', stake: '0.01', copy: 'prove the idea' },
    { name: 'serious mode', stake: '0.1', copy: 'make excuses hurt' },
    { name: 'no excuses', stake: '0.5', copy: 'this is who you are now' },
  ];
  return (
    <div className="fade-up-1">
      <div className="builder-copy">
        <span className="eyebrow">stake</span>
        <h3>what should be on the line?</h3>
        <p className="muted">enough to matter, not enough to make the app feel weird.</p>
      </div>
      <div className="intensity-grid">
        {modes.map((m) => (
          <button
            key={m.name}
            type="button"
            className={`intensity-card${intensity === m.name ? ' on' : ''}`}
            onClick={() => {
              setIntensity(m.name);
              setStake(m.stake);
            }}
          >
            <span>{m.name}</span>
            <b>{m.stake} ETH</b>
            <small>{m.copy}</small>
          </button>
        ))}
      </div>
      <label>
        amount
        <input
          name="stake"
          type="number"
          step="0.01"
          min="0.001"
          max="5"
          placeholder="0.1"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
        />
      </label>
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
      <div className="breakdown" style={{ marginTop: 18 }}>
        <div className="breakdown-row">
          <span>you stake</span>
          <b>{amt ? `${fmtNum(amt)} ETH` : '—'}</b>
        </div>
        <div className="breakdown-row green">
          <span>win → back to you</span>
          <b>{amt ? `${fmtNum(refund)} ETH` : '—'}</b>
        </div>
        <div className="breakdown-row red">
          <span>lose → referee takes</span>
          <b>{amt ? `${fmtNum(refund)} ETH` : '—'}</b>
        </div>
        <div className="breakdown-row blue">
          <span>protocol fee (2%)</span>
          <b>{amt ? `${fmtNum(fee)} ETH` : '—'}</b>
        </div>
      </div>
    </div>
  );
}

function Step4Review({
  goal,
  proof,
  referee,
  stake,
  days,
}: {
  goal: string;
  proof: string;
  referee: string;
  stake: string;
  days: number;
}) {
  const amt = parseFloat(stake) || 0;
  const fee = (amt * Number(FEE_BPS)) / 10_000;
  const refund = amt - fee;
  const fmtNum = (n: number) => String(n.toFixed(3)).replace(/\.?0+$/, '');
  return (
    <div className="review-card fade-up-1">
      <span className="eyebrow">send assert</span>
      <h3>ready to send this to your friend?</h3>
      <div className="review-line big">
        <span>i assert</span>
        <b>{goal}</b>
      </div>
      <div className="review-line">
        <span>proof</span>
        <b>{proof}</b>
      </div>
      <div className="review-line">
        <span>referee</span>
        <b>{referee}</b>
      </div>
      <div className="review-split">
        <div>
          <span>stake</span>
          <b>{fmtNum(amt)} ETH</b>
        </div>
        <div>
          <span>deadline</span>
          <b>{days} days</b>
        </div>
        <div>
          <span>if you hit it</span>
          <b>{fmtNum(refund)} ETH back</b>
        </div>
        <div>
          <span>if you fold</span>
          <b>referee gets {fmtNum(refund)} ETH</b>
        </div>
      </div>
    </div>
  );
}

function CreateWizard({ onCreated, initialReferee, contacts }: { onCreated: (id: bigint) => void; initialReferee?: string; contacts: Friend[] }) {
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState('');
  const [proof, setProof] = useState('');
  const [referee, setReferee] = useState(initialReferee ?? '');
  const [stake, setStake] = useState('');
  const [intensity, setIntensity] = useState('');
  const [days, setDays] = useState(7);
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resolvedReferee, setResolvedReferee] = useState<`0x${string}` | null>(null);
  const { writeContractAsync, isPending } = useWriteContract();
  const { chainId, address } = useAccount();
  const { switchChain } = useSwitchChain();
  const isBase = chainId === base.id;
  const onTestnet = chainId === baseSepolia.id;
  const publicClient = usePublicClient();

  const stepsLabel = ['promise', 'stake', 'friend', 'proof', 'confirm'];
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
        ? parseFloat(stake) >= 0.001
      : step === 2
        ? refereeResult.ok && !refereeResult.ensOnly
        : step === 3
          ? proof.trim().length > 0
          : true;

  const submittingRef = useRef(false);

  const submit = async () => {
    if (submittingRef.current) return;
    setError('');
    setSubmitting(true);
    submittingRef.current = true;
    const confirmCreated = async (before: bigint): Promise<bigint | null> => {
      for (let i = 0; i < 15; i++) {
        try {
          const now = (await publicClient!.readContract({
            address: COMMITMENT_ADDRESS,
            abi: commitmentAbi,
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
      if (chainId !== base.id && chainId !== baseSepolia.id) {
        setError('switch your wallet to base before creating.');
        return;
      }
      const amt = Number(stake);
      if (!amt || amt < 0.001) {
        setError('stake must be at least 0.001 ETH.');
        return;
      }
      if (amt > 5) {
        setError('stake can\'t exceed 5 ETH.');
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
      const deadline = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
      let before = 0n;
      try {
        before = (await publicClient!.readContract({
          address: COMMITMENT_ADDRESS,
          abi: commitmentAbi,
          functionName: 'nextId',
        })) as bigint;
      } catch {
        /* ignore */
      }

      let gh: `0x${string}` | undefined;
      try {
        gh = await writeContractAsync({
          address: COMMITMENT_ADDRESS,
          abi: commitmentAbi,
          functionName: 'createGoal',
          args: [goalText, refereeResult.addr!, deadline],
          value: parseUnits(stake, 18),
        });
      } catch (e: any) {
        // the tx may have landed anyway (stale wallet prompt / broadcast race) —
        // confirm onchain before blaming the user
        const landed = await confirmCreated(before);
        if (landed !== null) {
          onCreated(landed);
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
        await waitForTx(gh);
      } catch {
        /* receipt wait can time out even when the tx already mined — confirm below */
      }

      // pin the created id from the event log
      try {
        const receipt = await publicClient!.getTransactionReceipt({ hash: gh });
        const ev = getAbiItem({ abi: commitmentAbi, name: 'Created' });
        const logs = await publicClient!.getLogs({
          address: COMMITMENT_ADDRESS,
          event: ev,
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber,
        });
        const created = logs.find((l) => l.transactionHash === gh);
        const args = created?.args as CreatedArgs | undefined;
        if (args?.id) {
          onCreated(args.id);
          return;
        }
      } catch {
        /* non-fatal */
      }
      const createdId = await confirmCreated(before);
      onCreated(createdId ?? 0n);
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
        <h2>new assert</h2>
        <div className="network-chip-row">
          {onTestnet ? (
            <span className="network-chip testnet">base sepolia · testnet</span>
          ) : isBase ? (
            <span className="network-chip mainnet">base · mainnet</span>
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
      </div>

      {step === 0 && <Step1Goal goal={goal} setGoal={setGoal} />}
      {step === 1 && (
        <Step3Stake
          stake={stake}
          setStake={setStake}
          days={days}
          setDays={setDays}
          intensity={intensity}
          setIntensity={setIntensity}
        />
      )}
      {step === 2 && <Step2Referee value={referee} onChange={setReferee} onResolved={setResolvedReferee} friends={contacts} />}
      {step === 3 && <Step4Proof proof={proof} setProof={setProof} />}
      {step === 4 && <Step4Review goal={goal} proof={proof} referee={refereeResult.addr ?? referee} stake={stake} days={days} />}

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
        {step < 4 ? (
          <button
            type="button"
            className="btn-primary"
            disabled={!canNext}
            onClick={() => setStep((s) => s + 1)}
          >
            next →
          </button>
        ) : (
          <button type="submit" className="btn-primary" disabled={!canNext || isPending || submitting}>
            {submitting ? 'waiting for wallet…' : isPending ? 'locking…' : 'lock it in · assert it'}
          </button>
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
        ? `+${fmt(g.amount)} ETH kept`
        : st === 3
          ? `${fmt(g.amount)} ETH → referee`
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
      id: g.id.toString(),
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

function HomeAssertCard({ goal, status }: { goal: CreatedArgs; status: number }) {
  const cd = useCountdown(goal.deadline);
  const refereeName = short(goal.referee, 4);
  const label = status === 0 ? 'Pending' : 'Live';
  const live = status === 1;
  return (
    <article className={`home-assert-card${live ? ' live' : ''}`}>
      <div className="assert-pass-top">
        <span className={`live-pill ${label.toLowerCase()}`}>{label}</span>
        <b>{fmt(goal.amount)} ETH</b>
      </div>
      <h3>{splitGoalText(goal.goalText).title}</h3>
      <div className="home-assert-state">
        <ClockIcon />
        <div>
          {live ? (
            <>
              <span className="state-line">{refereeName} is watching</span>
              <span className="state-sub">
                {cd.expired ? 'time is up · referee calls it within 2 days' : `${cd.out} left`} · {refereeName} takes {fmt(goal.amount)} ETH if you bail
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
      <a href={`#g/${goal.id.toString()}`} className="home-assert-action">View assert →</a>
    </article>
  );
}

function AssertsTab({ myGoals }: { myGoals: CreatedArgs[] }) {
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
            myGoals.map((g) => <GoalCard key={g.id.toString()} id={g.id.toString()} only={filter} />)
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
  contacts,
  profiles,
  address,
  onStart,
  feed,
  myGoals,
  statuses,
}: {
  requests: CreatedArgs[];
  contacts: `0x${string}`[];
  profiles: Record<string, UserProfile>;
  address?: `0x${string}`;
  onStart: (friend?: Friend) => void;
  feed: SocialFeedItem[];
  myGoals: CreatedArgs[];
  statuses: (GoalStruct | undefined)[];
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
  const visibleRequests = requests.filter((r) => !dismissed.includes(r.id.toString()));
  const [filter, setFilter] = useState('');
  const filteredContacts = contacts.filter(
    (a) => !hiddenFriends.includes(a.toLowerCase()) && (!filter || short(a, 4).toLowerCase().includes(filter.toLowerCase())),
  );
  const accept = async (id: bigint) => {
    const h = await writeContractAsync({ address: COMMITMENT_ADDRESS, abi: commitmentAbi, functionName: 'acceptRole', args: [id] });
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
    }).catch((error) => console.warn('Supabase preferences save failed', error));
  };
  const dismiss = (id: bigint) => {
    const next = [...dismissed, id.toString()];
    setDismissed(next);
    persistPreferences(next, hiddenFriends);
  };
  const unfriend = (friendAddress: `0x${string}`) => {
    const next = [...hiddenFriends, friendAddress.toLowerCase()];
    setHiddenFriends(next);
    setOpenFriend(null);
    persistPreferences(dismissed, next);
  };
  const friendDetail = (friendAddress: `0x${string}`) => {
    const together = myGoals.filter((g) => g.creator === friendAddress || g.referee === friendAddress);
    const openEth = together.reduce((sum, g) => {
      const status = statuses[myGoals.indexOf(g)]?.[6];
      return status === 0 || status === 1 ? sum + Number(formatEther(g.amount)) : sum;
    }, 0);
    const assertCopy = `${together.length} assert${together.length === 1 ? '' : 's'} together`;
    return openEth ? `${assertCopy} · ${openEth.toFixed(3).replace(/\.?0+$/, '')} ETH on the line` : assertCopy;
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
        {visibleRequests.length ? (
          <div className="friend-requests">
            {visibleRequests.map((g) => (
              <div className="friend-card-wrap request-card" key={g.id.toString()}>
                <div className="friend-card">
                  <MiniAvatar name={short(g.creator, 4)} />
                  <div>
                    <h3>{short(g.creator, 4)} called you in</h3>
                    <p>{g.goalText}</p>
                    <b>{fmt(g.amount)} ETH</b>
                  </div>
                </div>
                <div className="friend-bubble request-actions" role="group">
                  <button type="button" className="btn green" onClick={() => accept(g.id)} disabled={isPending}>
                    {isPending ? 'accepting…' : 'accept role'}
                  </button>
                  <a href={`#g/${g.id.toString()}`} className="btn ghost view-assert">view assert →</a>
                  <button type="button" className="btn ghost" onClick={() => dismiss(g.id)} disabled={isPending}>
                    dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="friend-toolbar">
          <input className="friend-search" placeholder="search friends" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="small-blue" onClick={() => onStart()}>+ add friend</button>
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
              <button type="button" className="small-blue" onClick={() => onStart()}>+ add a friend</button>
            </div>
          )}
        </div>
      </section>
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
  const goals = useGoalsByIds(myGoals.map((g) => g.id));
  const won = goals.filter((g) => g?.[6] === 2).length;
  const bailed = goals.filter((g) => g?.[6] === 3).length;
  const finished = won + bailed;
  const completion = finished ? `${Math.round((won / finished) * 100)}%` : '—';
  const kept = goals.reduce(
    (sum, g) => sum + (g && g[6] === 2 ? Number(formatEther(g[3])) : 0),
    0,
  );
  const lost = goals.reduce(
    (sum, g) => sum + (g && g[6] === 3 ? Number(formatEther(g[3] - g[4])) : 0),
    0,
  );
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
          <div><span>kept</span><b>{kept ? `${kept.toFixed(2)} ETH` : '0 ETH'}</b></div>
          <div><span>lost</span><b>{lost ? `${lost.toFixed(2)} ETH` : '0 ETH'}</b></div>
        </div>
      </section>
      <section className="tab-shell">
        <div className="section-head clean">
          <h2 className="section-title">recent history</h2>
        </div>
        {history.length ? (
          history.map(({ goal: g, st }) => (
            <div className="history-row" key={g.id.toString()}>
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
  onStart,
  onViewAsserts,
  onViewActivity,
}: {
  myGoals: CreatedArgs[];
  statuses: (GoalStruct | undefined)[];
  feed: SocialFeedItem[];
  friendCount: number;
  onStart: () => void;
  onViewAsserts: () => void;
  onViewActivity: () => void;
}) {
  const livePairs = myGoals
    .map((g, i) => ({ g, st: statuses[i]?.[6] }))
    .filter(({ st }) => st === 0 || st === 1);
  const featured = livePairs
    .slice()
    .sort((a, b) => Number(a.g.deadline - b.g.deadline))[0];
  const active = livePairs.length;
  const ethAtRisk = livePairs.reduce((sum, { g }) => sum + Number(formatEther(g.amount)), 0);
  return (
    <div className="social-app">
      <section className="home-hero-card">
        <div>
          <img className="home-card-wordmark" src="/wordmark.png" alt="Assert" />
          <h2>{active ? `${active} assert${active === 1 ? '' : 's'} on the line.` : 'nothing on the line yet.'}</h2>
          <p>
            make one promise, put something behind it, and bring a friend in so it actually counts.
          </p>
        </div>
        <button className="home-plus" onClick={onStart} aria-label="create assert">+</button>
      </section>

      <div className="on-line-strip" aria-label="what's on the line">
        <span className="line-stat"><b>{ethAtRisk ? `${ethAtRisk.toFixed(3).replace(/\.?0+$/, '')} ETH` : '0 ETH'}</b> on the line</span>
        <span className="line-stat"><b>{active}</b> active</span>
        <span className="line-stat"><b>{friendCount || '0'}</b> friend{friendCount === 1 ? '' : 's'} watching</span>
      </div>

      {featured ? (
        <section className="active-carousel">
          <div className="section-head clean">
            <h2 className="section-title">active asserts</h2>
            <button className="tiny-link" type="button" onClick={onViewAsserts}>view all</button>
          </div>
          <HomeAssertCard goal={featured.g} status={featured.st ?? 0} />
        </section>
      ) : null}

      {feed.length ? (
        <section className="social-feed-section">
          <div className="section-head clean">
            <h2 className="section-title">recent activity</h2>
            <button className="tiny-link" type="button" onClick={onViewActivity}>see all →</button>
          </div>
          <SocialFeed rows={feed.slice(0, 4)} />
        </section>
      ) : null}
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

function BottomNav({ active, onSelect, pending }: { active: AppMode; onSelect: (mode: AppMode) => void; pending?: number }) {
  const items: { label: string; mode: AppMode }[] = [
    { label: 'Home', mode: 'home' },
    { label: 'Asserts', mode: 'asserts' },
    { label: '+', mode: 'builder' },
    { label: 'Friends', mode: 'friends' },
    { label: 'You', mode: 'you' },
  ];
  return (
    <nav className="bottom-nav" aria-label="app navigation">
      {items.map((item) => (
        <button
          key={item.mode}
          className={`${item.mode === 'builder' ? 'nav-plus' : ''}${active === item.mode ? ' active' : ''}`}
          onClick={() => onSelect(item.mode)}
        >
          {item.label}
          {item.mode === 'friends' && pending ? <span className="nav-badge">{pending > 9 ? '9+' : pending}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/* ---------------- share invite ---------------- */

function ShareInvite({ id, referee, onClose }: { id: bigint; referee: string; onClose: () => void }) {
  const link = `${window.location.origin}${window.location.pathname}#g/${id.toString()}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="invite your referee"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2><b>LOCKED IN</b></h2>
          <button className="modal-close" onClick={onClose} aria-label="close">×</button>
        </div>
        <p className="modal-sub muted">
          send this link to <b style={{ color: 'var(--indigo)' }}>{short(referee as `0x${string}`, 6)}</b> — when
          they open it, they'll see your assert and one-tap accept the referee role.
        </p>
        <div className="share-box">
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button
            className="btn-primary"
            onClick={() => {
              navigator.clipboard?.writeText(link).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
        </div>
        <p className="invite-copy muted" style={{ marginTop: 14 }}>
          or have them open <b>this app</b> — the assert will already show in their referee view.
        </p>
      </div>
    </div>
  );
}

/* ---------------- goal card ---------------- */

function GoalCard({ id, only, focused }: { id: string; only?: AssertFilter; focused?: boolean }) {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const { data } = useReadContract({
    address: COMMITMENT_ADDRESS,
    abi: commitmentAbi,
    functionName: 'goals',
    args: [BigInt(id)],
  });
  const raw = data as GoalStruct | undefined;
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
      address: COMMITMENT_ADDRESS,
      abi: commitmentAbi,
      functionName,
      args: [BigInt(id)],
    });
    await waitForTx(hash);
    window.location.reload();
  };

  return (
    <div className={`card goal assert-detail-card fade-up-1${status === 1 ? ' live' : ''}`}>
      <div className="goal-top assert-pass-top">
        <span className={`status s${status}`}>{STATUS_LABEL[status]}</span>
        <b>{fmt(amount)} ETH</b>
      </div>
      <p className="goal-text">{title}</p>
      {focused && description ? <p className="goal-desc">{description}</p> : null}
      {!focused ? <a className="goal-open" href={`#g/${id}`}>view assert →</a> : null}
      <div className="home-assert-state">
        <ClockIcon />
        <div>
          {status === 0 ? (
            <>
              <span className="state-line">Waiting on {isReferee ? 'you' : short(referee, 4)}.</span>
              <span className="state-sub">Referee must accept to activate the assert.</span>
            </>
          ) : status === 1 ? (
            <>
              <span className="state-line">{isReferee ? 'you' : short(referee, 4)} is watching you</span>
              <span className="state-sub">
                {graceOver
                  ? 'referee never called it — stake returned.'
                  : expired
                    ? 'time is up · referee has 2 days to call it'
                    : `${out} left`} · {isReferee ? 'you' : short(referee, 4)} takes {fmt(amount)} ETH if you bail
              </span>
            </>
          ) : status === 2 ? (
            <>
              <span className="state-line">Honored — stake returned</span>
              <span className="state-sub">{isCreator ? 'you' : short(creator, 4)} kept their word.</span>
            </>
          ) : status === 3 ? (
            <>
              <span className="state-line">Missed — {isReferee ? 'you' : short(referee, 4)} earned it</span>
              <span className="state-sub">Referee collected the stake.</span>
            </>
          ) : (
            <>
              <span className="state-line">Cancelled — full refund</span>
              <span className="state-sub">Assert voided — stake returned in full.</span>
            </>
          )}
        </div>
      </div>
      {(status === 0 || status === 1) && (
        <div className="outcome-split">
          <div className="outcome win">
            <span>you hit it</span>
            <b>{fmt(refund)} back</b>
          </div>
          <div className="outcome lose">
            <span>you miss</span>
            <b>{fmt(refund)} to referee</b>
          </div>
          <div className="outcome fee">protocol fee {fmt(feeAmount)} ({Number((feeAmount * 10000n) / amount)} bps)</div>
        </div>
      )}
      {(status === 0 || status === 1) && (
        <div className="assert-risk-strip detail-risk-strip">
          <span>Bail → {isReferee ? 'you' : short(referee, 4)} gets {fmt(refund)} ETH</span>
        </div>
      )}
      <div className="goal-actions">
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
      </div>
    </div>
  );
}

/* ---------------- landing ---------------- */

function LandingNav() {
  return (
    <div className="landing-nav">
      <img className="brand-wordmark" src="/wordmark.png" alt="assert" />
      <ConnectButton label="Enter app →" />
    </div>
  );
}

function LandingAssertCard() {
  return (
    <img className="landing-phone fade-up fade-up-2" src="/assert-card.png" alt="Live Assert card for gym 4x this week" />
  );
}

const LANDING_ACTIVITY = [
  { who: 'Josh', body: 'completed Gym 4× this week', meta: 'Mia approved it · 20m ago', badge: 'WON' },
  { who: 'Mia', body: 'put 0.03 ETH on reading daily', meta: 'deadline in 7 days', badge: 'LIVE' },
  { who: 'Ade', body: 'locked 0.10 ETH on no nicotine', meta: 'Sam refereeing · day 5', badge: 'LIVE' },
  { who: 'Liv', body: 'folded on her 6am run', meta: 'referee got paid', badge: 'FOLDED' },
  { who: 'Noah', body: 'proved 5 deep work blocks', meta: 'stake returned', badge: 'WON' },
];

function LandingActivity() {
  return (
    <section id="people" className="landing-activity fade-up fade-up-3" aria-label="recent assert activity">
      {LANDING_ACTIVITY.slice(0, 4).map((item, index) => (
        <div className={`activity-row static floating-row row-${index + 1} ${item.badge.toLowerCase()}`} key={`${item.who}-${item.body}`}>
          <div className="avatar">{item.who[0]}</div>
          <div>
            <p><b>{item.who}</b> <strong>{item.body}</strong></p>
            <span>{item.meta}</span>
          </div>
          <div className="activity-side"><b>{item.badge}</b></div>
        </div>
      ))}
    </section>
  );
}

function LandingCardStack() {
  return (
    <div className="landing-card-stack">
      <LandingAssertCard />
    </div>
  );
}

function LandingFinalCta() {
  return (
    <section className="landing-final fade-up fade-up-4">
      <h2>Still sure?</h2>
      <ConnectButton label="Assert it →" />
      <div className="landing-footer">
        <span>Assert</span>
        <span>built on Base</span>
        <span className="footer-legal">
          <a href="#/terms">terms</a>
          <span>·</span>
          <a href="#/privacy">privacy</a>
        </span>
      </div>
    </section>
  );
}

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

function LandingSubstance() {
  return (
    <section className="landing-substance" aria-label="how Assert works">
      <div className="landing-step step-blue">
        <div className="step-top">
          <span className="step-id">
            <span className="step-num">01</span>
            <span className="step-label">promise</span>
          </span>
          <span className="step-icon-chip">
            <svg className="step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="8.5" />
              <circle cx="12" cy="12" r="4.5" />
              <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
            </svg>
          </span>
        </div>
        <p>say the thing you keep putting off. out loud.</p>
      </div>
      <div className="landing-step step-green">
        <div className="step-top">
          <span className="step-id">
            <span className="step-num">02</span>
            <span className="step-label">stake</span>
          </span>
          <span className="step-icon-chip">
            <svg className="step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
              <ellipse cx="12" cy="7.6" rx="7" ry="4" />
              <path d="M5 7.6v4.8c0 2.2 3.1 4 7 4s7-1.8 7-4V7.6" />
              <path d="M5 12.4v4.8c0 2.2 3.1 4 7 4s7-1.8 7-4v-4.8" />
            </svg>
          </span>
        </div>
        <p>put real money behind your word. no takebacks.</p>
      </div>
      <div className="landing-step step-lavender">
        <div className="step-top">
          <span className="step-id">
            <span className="step-num">03</span>
            <span className="step-label">referee</span>
          </span>
          <span className="step-icon-chip">
            <svg className="step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l8 3v5c0 4.6-3.2 8.7-8 10-4.8-1.3-8-5.4-8-10V6z" />
              <path d="M9 12l2 2 4-4.5" />
            </svg>
          </span>
        </div>
        <p>your friend calls it when time is up. fair.</p>
      </div>
    </section>
  );
}

/* ---------------- app ---------------- */

export default function App() {
  const { isConnected, chainId, address } = useAccount();
  const [appMode, setAppMode] = useState<AppMode>(() => {
    const saved = localStorage.getItem('assert-app-mode');
    return saved === 'home' || saved === 'asserts' || saved === 'builder' || saved === 'friends' || saved === 'you'
      ? saved
      : 'intro';
  });
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>(readProfiles);
  const [draftReferee, setDraftReferee] = useState<string | undefined>();
  const onKnownChain = chainId === 8453 || chainId === 84532;
  const { data: allGoals } = useAllCreated();
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
    const m = window.location.hash.match(/^#g\/(\d+)$/);
    return m ? m[1] : null;
  });
  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(/^#g\/(\d+)$/);
      setInvited(m ? m[1] : null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const myGoals = (allGoals ?? []).filter(
    (g) => address && (g.creator === address || g.referee === address),
  );
  const myStatuses = useGoalsByIds(myGoals.map((g) => g.id));
  const refereeRequests = myGoals.filter(
    (g, i) => g.referee === address && myStatuses[i]?.[6] === 0,
  );
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
  const circleStatuses = useGoalsByIds(circleGoals.map((g) => g.id));
  const feed = activityFromGoals(circleGoals, circleStatuses, {
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
  const invoked = invited ? (allGoals ?? []).find((g) => g.id.toString() === invited) : undefined;

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
      <div className="aurora" aria-hidden="true" />
      <header>{!isConnected ? <LandingNav /> : null}</header>

      {!isConnected ? (
        <>
          <section className="hero landing-hero">
            <div className="hero-inner landing-hero-inner">
              <div className="landing-copy">
                <h1 className="fade-up fade-up-1">assert it, or fold.</h1>
                <p className="lead fade-up fade-up-2">Put money behind your word.</p>
                <p className="hero-line fade-up fade-up-2">Your friend calls it.</p>
                <div className="hero-actions fade-up fade-up-3">
                  <ConnectButton label="Assert something →" />
                </div>
              </div>
              <LandingCardStack />
            </div>
          </section>

          <main className="landing-main">
            <LandingActivity />
            <LandingSubstance />
            <LandingFinalCta />
          </main>
        </>
      ) : (
        <main>
          {invited ? (
            <GoalCard id={invited} focused />
          ) : null}

          {invited ? null : appMode === 'intro' ? (
            <ConnectedIntro onStart={() => setAppMode('home')} profile={profile} />
          ) : appMode === 'builder' ? (
            <div className="create-screen">
              {!onKnownChain && (
                <div className="banner action-warning">switch to <b>base</b> before locking an assert.</div>
              )}
              <CreateWizard key={draftReferee ?? 'empty-referee'} initialReferee={draftReferee} contacts={contactFriends} onCreated={(id) => setInviteId(id > 0n ? id.toString() : null)} />
            </div>
          ) : appMode === 'asserts' ? (
            <AssertsTab myGoals={myGoals} />
          ) : appMode === 'friends' ? (
            <FriendsTab
              requests={refereeRequests}
              contacts={contacts}
              profiles={profiles}
              address={address}
              onStart={startBuilder}
              feed={feed}
              myGoals={myGoals}
              statuses={myStatuses}
            />
          ) : appMode === 'you' ? (
            <ProfileTab key={address} myGoals={myGoals} profile={profile} address={address} onSave={saveProfile} />
          ) : (
            <DisciplineHome
              myGoals={myGoals}
              statuses={myStatuses}
              feed={feed}
              friendCount={contacts.length}
              onStart={() => startBuilder()}
              onViewAsserts={() => selectMode('asserts')}
              onViewActivity={() => selectMode('friends')}
            />
          )}
          {inviteId ? (
            <ShareInvite
              id={BigInt(inviteId)}
              referee={invoked?.referee ?? '0x0'}
              onClose={() => setInviteId(null)}
            />
          ) : null}
          {appMode !== 'intro' || invited ? <BottomNav active={appMode} onSelect={selectMode} pending={refereeRequests.length} /> : null}
        </main>
      )}

      {isConnected ? (
        <footer className="muted">
          assert — on your honor, onchain. ·{' '}
          <a className="legal-inline" href="#/terms">terms</a> ·{' '}
          <a className="legal-inline" href="#/privacy">privacy</a>
        </footer>
      ) : null}
    </div>
  );
}
