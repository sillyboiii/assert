import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, getAbiItem, getAddress, http, parseUnits, formatEther } from 'viem';
import { baseSepolia, mainnet } from 'viem/chains';
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
  const [resolvedReferee, setResolvedReferee] = useState<`0x${string}` | null>(null);
  const { writeContractAsync, isPending } = useWriteContract();
  const { chainId, address } = useAccount();
  const { switchChain } = useSwitchChain();
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

  const submit = async () => {
    setError('');
    try {
      if (chainId !== baseSepolia.id) {
        setError('switch your wallet to base sepolia (testnet) before creating — mainnet uses real money.');
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
      const gh = await writeContractAsync({
        address: COMMITMENT_ADDRESS,
        abi: commitmentAbi,
        functionName: 'createGoal',
        args: [goalText, refereeResult.addr!, deadline],
        value: parseUnits(stake, 18),
      });
      setTxHash(gh);
      await waitForTx(gh);
      // find the newly created goal id for the share link
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
      onCreated(0n);
    } catch (e: any) {
      const code = e?.cause?.code ?? e?.code;
      const base =
        code === 4001
          ? 'you rejected the transaction in your wallet.'
          : e?.shortMessage?.includes('reverted') || e?.cause?.data
            ? 'the contract rejected this — check your stake, referee and deadline.'
            : e?.shortMessage ?? e?.message ?? 'transaction failed';
      setError(`${base}${code ? ` (code ${code})` : ''}`);
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
          ) : (
            <button
              type="button"
              className="network-chip switch"
              onClick={() => switchChain({ chainId: baseSepolia.id })}
            >
              switch to base sepolia ↻
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
      {txHash && !isPending && (
        <p className="muted" style={{ fontSize: 13 }}>
          tx {short(txHash, 6)} confirmed — finding your new assert…
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
          <button type="submit" className="btn-primary" disabled={!canNext || isPending}>
            {isPending ? 'locking…' : 'lock it in · assert it'}
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
};

function activityFromGoals(
  myGoals: CreatedArgs[],
  statuses: (GoalStruct | undefined)[],
): SocialFeedItem[] {
  return myGoals.map((g, i) => {
    const st = statuses[i]?.[6];
    const badge: SocialFeedItem['badge'] =
      st === 2 ? 'won' : st === 3 ? 'folded' : st === 1 ? 'live' : 'day';
    const action = st === 2 ? 'won the assert' : st === 3 ? 'bailed on' : st === 4 ? 'cancelled' : st === 0 ? 'asserted' : 'is pushing';
    const meta = st === 0 ? 'waiting on referee' : `status: ${STATUS_LABEL[st ?? 0].toLowerCase()}`;
    const result =
      st === 2
        ? `+${fmt(g.amount)} ETH kept`
        : st === 3
          ? `${fmt(g.amount)} ETH → referee`
          : st === 4
            ? 'refunded to you'
            : undefined;
    return { who: 'you', action, body: g.goalText, meta, badge, reaction: '0', result };
  });
}

const PILL_LABEL: Record<SocialFeedItem['badge'], string> = { won: 'WON', live: 'LIVE', day: 'DAY 5', folded: 'FOLDED' };

function SocialFeedRow({ item, onOpen }: { item: SocialFeedItem; onOpen?: () => void }) {
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
            className={`feed-heart${hearted ? ' on' : ''}`}
            aria-pressed={hearted}
            onClick={() => setHearted((h) => !h)}
            aria-label="react"
          >
            {hearted ? '♥' : '♡'} {reaction}
          </button>
          <button onClick={onOpen} aria-label="open assert">open assert →</button>
        </div>
      </div>
    </div>
  );
}

function SocialFeed({ rows, onOpen }: { rows: SocialFeedItem[]; onOpen?: () => void }) {
  return (
    <div className="social-feed">
      {rows.map((item) => (
        <SocialFeedRow key={`${item.who}-${item.body}`} item={item} onOpen={onOpen} />
      ))}
    </div>
  );
}

type AppMode = 'intro' | 'home' | 'asserts' | 'builder' | 'friends' | 'you';
type AssertFilter = 'Live' | 'Pending' | 'Won' | 'Bailed';

const FILTERS: AssertFilter[] = ['Live', 'Pending', 'Won', 'Bailed'];

function AssertCard({ goal, status = 'Live' }: { goal: CreatedArgs; status?: AssertFilter }) {
  const cd = useCountdown(goal.deadline);
  const refereeName = short(goal.referee, 4);
  const [open, setOpen] = useState(false);
  return (
    <button
      className={`assert-card${open ? ' expanded' : ''}`}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
    >
      <div className="assert-pass-top">
        <span className={`live-pill ${status.toLowerCase()}`}>{status}</span>
        <b>{fmt(goal.amount)} ETH</b>
      </div>
      <h3>{goal.goalText}</h3>
      <div className="assert-human-row">
        <span><MiniAvatar name={refereeName} />{refereeName} · referee</span>
        <span className={cd.urgent && !cd.expired ? 'time-left urgent' : 'time-left'}>{cd.expired ? 'done' : `${cd.out} left`}</span>
      </div>
      {open ? (
        <div className="assert-details">
          <div className="assert-risk-strip">
            <span>Bail → {refereeName} gets {fmt(goal.amount)} ETH</span>
          </div>
        </div>
      ) : null}
      <span className="assert-toggle">{open ? 'show less' : 'show more'}<i>{open ? '↑' : '↓'}</i></span>
    </button>
  );
}

function AssertsTab({ myGoals }: { myGoals: CreatedArgs[] }) {
  const [filter, setFilter] = useState<AssertFilter>('Live');
  return (
    <div className="social-app fade-up">
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
}: {
  requests: CreatedArgs[];
  contacts: `0x${string}`[];
  profiles: Record<string, UserProfile>;
  address?: `0x${string}`;
  onStart: (friend?: Friend) => void;
  feed: SocialFeedItem[];
}) {
  const { writeContractAsync, isPending } = useWriteContract();
  const dismissKey = address ? `assert-dismiss-referee:${address.toLowerCase()}` : '';
  const [dismissed, setDismissed] = useState<string[]>(() => {
    if (!address) return [];
    try { return JSON.parse(localStorage.getItem(dismissKey) ?? '[]'); } catch { return []; }
  });
  const visibleRequests = requests.filter((r) => !dismissed.includes(r.id.toString()));
  const [filter, setFilter] = useState('');
  const filteredContacts = contacts.filter((a) => !filter || short(a, 4).toLowerCase().includes(filter.toLowerCase()));
  const accept = async (id: bigint) => {
    const h = await writeContractAsync({ address: COMMITMENT_ADDRESS, abi: commitmentAbi, functionName: 'acceptRole', args: [id] });
    await waitForTx(h);
    window.location.reload();
  };
  const dismiss = (id: bigint) => {
    const next = [...dismissed, id.toString()];
    setDismissed(next);
    if (address) localStorage.setItem(dismissKey, JSON.stringify(next));
  };
  return (
    <div className="social-app fade-up">
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
        ) : (
          <p className="empty-copy" style={{ marginTop: 0 }}>no pending referee requests.</p>
        )}
        <input className="friend-search" placeholder="search contacts" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
                  <button className="friend-card" onClick={() => onStart(f)}>
                    <MiniAvatar name={f.name} src={f.pfp} />
                    <div>
                      <h3>{f.name}</h3>
                      <p>{f.detail}</p>
                    </div>
                    <div className="friend-meta"><b>{f.role}</b></div>
                  </button>
                </div>
              );
            })
          ) : (
            <p className="empty-copy" style={{ marginTop: 0 }}>no contacts yet — create an assert with a friend to get started.</p>
          )}
        </div>
      </section>
      <section className="social-feed-section">
        <div className="section-head clean">
          <h2 className="section-title">recent activity</h2>
        </div>
        {feed.length ? (
          <SocialFeed rows={feed.slice(0, 4)} />
        ) : (
          <p className="empty-copy">no activity yet.</p>
        )}
      </section>
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
    <div className="social-app fade-up">
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
  allGoals,
  myGoals,
  statuses,
  friendCount,
  loadingGoals,
  onStart,
}: {
  allGoals?: CreatedArgs[];
  myGoals: CreatedArgs[];
  statuses: (GoalStruct | undefined)[];
  friendCount: number;
  loadingGoals: boolean;
  onStart: () => void;
}) {
  const active = myGoals.filter((g) => Number(g.deadline) * 1000 > Date.now()).length;
  const ethAtRisk = myGoals.reduce((sum, g) => sum + Number(formatEther(g.amount)), 0);
  const livePairs = myGoals
    .map((g, i) => ({ g, st: statuses[i]?.[6] }))
    .filter(({ st }) => st === 0 || st === 1);
  const feed = activityFromGoals(myGoals, statuses);
  return (
    <div className="social-app fade-up">
      <section className="home-hero-card">
        <div>
          <img className="home-card-wordmark" src="/wordmark.png" alt="Assert" />
          <span className="eyebrow">home</span>
          <h2>{active ? `${active} assert${active === 1 ? '' : 's'} on the line.` : 'nothing on the line yet.'}</h2>
          <p>
            make one promise, put something behind it, and bring a friend in so it actually counts.
          </p>
        </div>
        <button className="home-plus" onClick={onStart} aria-label="create assert">+</button>
      </section>

      <section className="on-line-strip" aria-label="what's on the line">
        <div>
          <span>on the line</span>
          <b>{ethAtRisk ? `${ethAtRisk.toFixed(3).replace(/\.?0+$/, '')} ETH` : '0 ETH'}</b>
        </div>
        <div>
          <span>active</span>
          <b>{active}</b>
        </div>
        <div>
          <span>friends watching</span>
          <b>{friendCount || '0'}</b>
        </div>
      </section>

      <section className="active-carousel">
        <div className="section-head clean">
          <h2 className="section-title">active asserts</h2>
          <span className="section-sub muted">what’s currently at risk</span>
        </div>
        {livePairs.length ? (
          <div className="active-scroll">
            {livePairs.map(({ g, st }) => (
              <AssertCard key={g.id.toString()} goal={g} status={st === 0 ? 'Pending' : 'Live'} />
            ))}
          </div>
        ) : (
          <p className="empty-copy">nothing live yet. start one and send it to a friend.</p>
        )}
      </section>

      <section className="social-feed-section">
        <div className="section-head clean">
          <h2 className="section-title">recent activity</h2>
        </div>
        {feed.length ? (
          <SocialFeed rows={feed.slice(0, 4)} onOpen={onStart} />
        ) : (
          <p className="empty-copy">no activity yet.</p>
        )}
      </section>

      <section className="app-panel your-panel social-panel">
        <div className="section-head">
          <h2 className="section-title">your asserts</h2>
          <span className="section-sub muted">your current promises</span>
        </div>
        {loadingGoals ? (
          <p className="muted">loading asserts…</p>
        ) : myGoals.length ? (
          <div className="goal-grid compact">
            {myGoals.map((g) => (
              <GoalCard key={g.id.toString()} id={g.id.toString()} />
            ))}
          </div>
        ) : (
          <p className="empty-copy">no active asserts yet. start one and send it to a friend.</p>
        )}
      </section>

      <section className="app-panel top-panel social-panel">
        <div className="section-head">
          <h2 className="section-title">top asserts</h2>
          <span className="section-sub muted">people putting money where their mouth is</span>
        </div>
        <TopAsserts goals={allGoals} limit={6} seeded />
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
          <h2>locked in 🎯</h2>
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

function GoalCard({ id, only }: { id: string; only?: AssertFilter }) {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const { data } = useReadContract({
    address: COMMITMENT_ADDRESS,
    abi: commitmentAbi,
    functionName: 'goals',
    args: [BigInt(id)],
  });
  const raw = data as GoalStruct | undefined;
  const { out, urgent, expired } = useCountdown(raw?.[5]);
  if (!raw) return null;

  const [creator, referee, goalText, amount, feeAmount, deadline, status] = raw;
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
  const now = BigInt(Math.floor(Date.now() / 1000));
  const daysLeft = Number((deadline - now) / 86400n);
  const refund = amount - feeAmount;

  const run = async (functionName: 'acceptRole' | 'approve' | 'cancel' | 'claimReferee') => {
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
    <div className="card goal assert-detail-card fade-up-1">
      <div className="goal-top assert-pass-top">
        <span className={`status s${status}`}>{STATUS_LABEL[status]}</span>
        <b>{fmt(amount)} ETH</b>
      </div>
      <p className="goal-text">{goalText}</p>
      <div className="assert-human-row goal-human-row">
        <span><MiniAvatar name={isReferee ? 'you' : short(referee, 4)} />{isReferee ? 'you' : short(referee, 4)} · referee</span>
        <span>{expired ? 'done' : `${out} left`}</span>
      </div>
      <div className="goal-meta">
        <span>{isCreator ? 'you' : short(creator, 4)} asserted it</span>
        {status === 1 && (
          <div className={`countdown${urgent ? ' urgent' : ''}`}>
            {expired ? '0h 0m 00s' : out}
          </div>
        )}
        {status === 1 && !expired && (
          <span className="muted">{daysLeft < 1 ? 'under a day left!' : `~${daysLeft}d left`}</span>
        )}
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
        {status === 1 && isReferee && (
          <button className="btn green" onClick={() => run('approve')} disabled={isPending}>
            ✓ they did it
          </button>
        )}
        {status === 1 && expired && (
          <button className="btn red" onClick={() => run('claimReferee')} disabled={isPending}>
            referee earns stake
          </button>
        )}
        {status === 1 && isCreator && expired ? (
          <button className="btn ghost" onClick={() => run('claimReferee')} disabled={isPending}>
            I missed it — pay out
          </button>
        ) : null}
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

/* ---------------- feed / leaderboard ---------------- */

function TopAssertRow({ goal, rank, seeded }: { goal: CreatedArgs; rank: number; seeded: boolean }) {
  const cd = useCountdown(goal.deadline);
  return (
    <div className={`feed-row ${rank < 3 ? `rank rank-${rank + 1}` : ''} fade-up-1`}>
      <span className={`feed-rank${rank < 3 ? ' top' : ''}`}>
        {['🥇', '🥈', '🥉'][rank] ?? `#${rank + 1}`}
      </span>
      <div className="feed-main">
        <div className="feed-goal">{goal.goalText}</div>
        <div className="feed-meta">
          {seeded ? 'someone on base' : short(goal.creator)} → vs {seeded ? 'their referee' : short(goal.referee)}
        </div>
      </div>
      <span className="feed-amount">{fmt(goal.amount)} ETH</span>
      <span className={`feed-countdown${cd.urgent && !cd.expired ? ' urgent' : ''}`}>
        {cd.expired ? 'done' : cd.out}
      </span>
    </div>
  );
}

function TopAsserts({ goals, limit = 8, seeded = false }: { goals?: CreatedArgs[]; limit?: number; seeded?: boolean }) {
  const src = goals ?? [];
  const sorted = useMemo(() => [...src].sort((a, b) => (a.amount < b.amount ? 1 : -1)), [src]);
  const rows = sorted.slice(0, limit);
  return (
    <div className="feed-list">
      {rows.map((g, i) => <TopAssertRow key={g.id.toString()} goal={g} rank={i} seeded={seeded && !goals?.length} />)}
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
          'When you assert a goal, your stake is locked onchain and is not refundable. If you hit your commitment your stake and your referee\'s stake are returned. If you miss, the pot is paid out as the rules you agreed to when you created the commitment.',
          'Transactions on Base cannot be reversed. Double-check every goal, amount, deadline and referee before you sign — there are no takebacks, by design.',
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
          'Questions about these terms? Reach us through the site at assert-three.vercel.app.',
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
          'Your wallet address (so the app can show you your commitments and profile), a username and optional profile picture that you choose and that we store only in your browser\'s local storage, and onchain data — goals, stakes and referee decisions — which is public by the nature of blockchain.',
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
        heading: '6. your local data is yours',
        paras: [
          'Your profile stays in your browser\'s local storage on this device. Clearing your browser data removes it; it is never copied to our servers.',
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
          'We may update this policy from time to time; the date above reflects the latest version. Questions? Reach us through the site at assert-three.vercel.app.',
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
  const [appMode, setAppMode] = useState<AppMode>('intro');
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>(readProfiles);
  const [draftReferee, setDraftReferee] = useState<string | undefined>();
  const onKnownChain = chainId === 8453 || chainId === 84532;
  const { data: allGoals, isLoading: loadingGoals } = useAllCreated();
  const profile = address ? profiles[address] ?? defaultProfile(address) : defaultProfile();
  const saveProfile = (nextProfile: UserProfile) => {
    if (!address) return;
    const nextProfiles = { ...profiles, [address]: nextProfile };
    setProfiles(nextProfiles);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(nextProfiles));
  };

  // deep link: #g/<id>
  const [inviteId, setInviteId] = useState<string | null>(null);
  const invited = useMemo(() => {
    const m = window.location.hash.match(/^#g\/(\d+)$/);
    return m ? m[1] : null;
  }, []);

  const myGoals = (allGoals ?? []).filter(
    (g) => address && (g.creator === address || g.referee === address),
  );
  const myStatuses = useGoalsByIds(myGoals.map((g) => g.id));
  const refereeRequests = myGoals.filter(
    (g, i) => g.referee === address && myStatuses[i]?.[6] === 0,
  );
  const feed = activityFromGoals(myGoals, myStatuses);
  const contacts = useMemo(() => {
    const set = new Set<`0x${string}`>();
    for (const g of allGoals ?? []) {
      if (address && g.creator === address && g.referee !== address) set.add(g.referee);
      if (address && g.referee === address && g.creator !== address) set.add(g.creator);
    }
    return [...set];
  }, [allGoals, address]);
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
            <GoalCard id={invited} />
          ) : null}

          {invited ? null : appMode === 'intro' ? (
            <ConnectedIntro onStart={() => setAppMode('home')} profile={profile} />
          ) : appMode === 'builder' ? (
            <div className="create-screen fade-up">
              {!onKnownChain && (
                <div className="banner action-warning">switch to <b>base</b> before locking an assert.</div>
              )}
              <CreateWizard key={draftReferee ?? 'empty-referee'} initialReferee={draftReferee} contacts={contactFriends} onCreated={(id) => setInviteId(id > 0n ? id.toString() : null)} />
            </div>
          ) : appMode === 'asserts' ? (
            <AssertsTab myGoals={myGoals} />
          ) : appMode === 'friends' ? (
            <FriendsTab requests={refereeRequests} contacts={contacts} profiles={profiles} address={address} onStart={startBuilder} feed={feed} />
          ) : appMode === 'you' ? (
            <ProfileTab key={address} myGoals={myGoals} profile={profile} address={address} onSave={saveProfile} />
          ) : (
            <DisciplineHome
              allGoals={allGoals}
              myGoals={myGoals}
              statuses={myStatuses}
              friendCount={contacts.length}
              loadingGoals={loadingGoals}
              onStart={() => startBuilder()}
            />
          )}
          {inviteId ? (
            <ShareInvite
              id={BigInt(inviteId)}
              referee={invoked?.referee ?? '0x0'}
              onClose={() => setInviteId(null)}
            />
          ) : null}
          {appMode !== 'intro' && !invited ? <BottomNav active={appMode} onSelect={selectMode} pending={refereeRequests.length} /> : null}
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
