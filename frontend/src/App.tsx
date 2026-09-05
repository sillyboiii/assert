import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, getAbiItem, getAddress, http, parseUnits, formatEther } from 'viem';
import { base, mainnet } from 'viem/chains';
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
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

const short = (a: `0x${string}` | undefined, n = 4) =>
  a ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : '';
const fmt = (w: bigint) => (w === 0n ? '0' : Number(formatEther(w)).toFixed(3).replace(/\.?0+$/, ''));
const FEE_BPS = 200n; // 2% protocol fee, mirrors the live contract

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

const baseClient = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org', { timeout: 15_000 }),
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

function useAllCreated() {
  const createdEvent = getAbiItem({ abi: commitmentAbi, name: 'Created' });
  return useQuery({
    queryKey: ['allCreated'],
    queryFn: async () => {
      // public base RPCs cap eth_getLogs at 10k-range windows, so we walk
      // backward from latest in chunks and stop at the deploy boundary
      const latest = await baseClient.getBlockNumber();
      const CHUNK = 9_900n; // RPC caps inclusive from..to at 10,000
      const MAX_CHUNKS = 40n; // ~396k blocks, way past the contract's young life
      const seen = new Map<string, CreatedArgs>();
      for (let i = 0n; i < MAX_CHUNKS; i++) {
        const to = latest - i * CHUNK;
        if (to <= 0n) break;
        const from = to - CHUNK < 0n ? 0n : to - CHUNK;
        const logs = await baseClient.getLogs({
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
}: {
  value: string;
  onChange: (v: string) => void;
  onResolved: (addr: `0x${string}` | null) => void;
}) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

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
      <label>
        choose a friend
        <input
          name="referee"
          placeholder="friend.eth or 0x1234…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
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

function CreateWizard({ onCreated }: { onCreated: (id: bigint) => void }) {
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState('');
  const [proof, setProof] = useState('');
  const [referee, setReferee] = useState('');
  const [stake, setStake] = useState('');
  const [intensity, setIntensity] = useState('');
  const [days, setDays] = useState(7);
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [resolvedReferee, setResolvedReferee] = useState<`0x${string}` | null>(null);
  const { writeContractAsync, isPending } = useWriteContract();
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
      setError(e?.shortMessage ?? e?.message ?? 'transaction failed');
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
      {step === 2 && <Step2Referee value={referee} onChange={setReferee} onResolved={setResolvedReferee} />}
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

function ConnectedIntro({ onStart }: { onStart: () => void }) {
  return (
    <section className="intro-scene">
      <span className="intro-line intro-line-1">wallet connected.</span>
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

const SOCIAL_ACTIVITY = [
  { who: 'Josh', action: 'completed', body: 'Gym 4x this week', meta: 'Mia approved it · 20m ago', badge: 'won', reaction: '12' },
  { who: 'Mia', action: 'put', body: '0.03 ETH on reading every day', meta: 'deadline in 7 days', badge: 'live', reaction: '8' },
  { who: 'Ade', action: 'checked in', body: 'no nicotine, day 5', meta: 'Sam is watching', badge: 'day 5', reaction: '15' },
  { who: 'Liv', action: 'bailed on', body: 'her 6am run', meta: 'referee got paid', badge: 'folded', reaction: '6' },
];

const FRIENDS = [
  { name: 'Josh', role: 'referee', record: '8 won · 2 bailed', detail: 'gym, running, early mornings' },
  { name: 'Mia', role: 'watching you', record: '12 won · 1 bailed', detail: 'reading, no sugar, focus blocks' },
  { name: 'Ade', role: 'live assert', record: '5 day streak', detail: 'no nicotine' },
  { name: 'Liv', role: 'referee', record: '4 won · 3 bailed', detail: 'wellness and sleep' },
];

type AppMode = 'intro' | 'home' | 'asserts' | 'builder' | 'friends' | 'you';
type AssertFilter = 'Live' | 'Pending' | 'Won' | 'Bailed';

const FILTERS: AssertFilter[] = ['Live', 'Pending', 'Won', 'Bailed'];

function sampleStatus(id: bigint): AssertFilter {
  return (['Live', 'Pending', 'Won', 'Bailed'] as const)[Number(id % 4n)];
}

function AssertPreviewCard({ goal, status }: { goal: CreatedArgs; status: AssertFilter }) {
  const cd = useCountdown(goal.deadline);
  return (
    <button className="assert-preview-card">
      <div className="assert-preview-top">
        <span className={`assert-pill ${status.toLowerCase()}`}>{status}</span>
        <b>{fmt(goal.amount)} ETH</b>
      </div>
      <h3>{goal.goalText}</h3>
      <p>{short(goal.referee)} is referee · {cd.expired ? 'done' : cd.out}</p>
    </button>
  );
}

function AssertsTab({ myGoals }: { myGoals: CreatedArgs[] }) {
  const [filter, setFilter] = useState<AssertFilter>('Live');
  const examples = SAMPLE_ASSERTS.filter((g) => sampleStatus(g.id) === filter).slice(0, 3);
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
            myGoals.map((g) => <GoalCard key={g.id.toString()} id={g.id.toString()} />)
          ) : examples.length ? (
            examples.map((g) => <AssertPreviewCard key={g.id.toString()} goal={g} status={filter} />)
          ) : (
            <p className="empty-copy">nothing {filter.toLowerCase()} yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function FriendsTab({ onStart }: { onStart: () => void }) {
  return (
    <div className="social-app fade-up">
      <section className="tab-shell">
        <div className="tab-head inline">
          <div>
            <span className="eyebrow">friends</span>
            <h2>your referees</h2>
          </div>
          <button className="small-blue">invite</button>
        </div>
        <input className="friend-search" placeholder="search or invite a friend" />
        <div className="friend-list">
          {FRIENDS.map((f) => (
            <button className="friend-card" key={f.name} onClick={onStart}>
              <div className="avatar">{f.name[0]}</div>
              <div>
                <h3>{f.name}</h3>
                <p>{f.detail}</p>
              </div>
              <div className="friend-meta">
                <b>{f.role}</b>
                <span>{f.record}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
      <section className="activity-panel embedded">
        <div className="section-head clean">
          <h2 className="section-title">their activity</h2>
        </div>
        {SOCIAL_ACTIVITY.slice(0, 3).map((item) => (
          <button className={`activity-row ${item.action.replaceAll(' ', '-')}`} key={`${item.who}-${item.body}`} onClick={onStart}>
            <div className="avatar">{item.who[0]}</div>
            <div>
              <p><b>{item.who}</b> {item.action} <strong>{item.body}</strong></p>
              <span>{item.meta}</span>
            </div>
            <div className="activity-side"><b>{item.badge}</b><span>♡ {item.reaction}</span></div>
          </button>
        ))}
      </section>
    </div>
  );
}

function ProfileTab({ myGoals }: { myGoals: CreatedArgs[] }) {
  const total = myGoals.length;
  const ethAtRisk = myGoals.reduce((sum, g) => sum + Number(formatEther(g.amount)), 0);
  return (
    <div className="social-app fade-up">
      <section className="profile-card">
        <div className="profile-top">
          <div className="profile-avatar">Y</div>
          <div>
            <span className="eyebrow">you</span>
            <h2>sillyboi.base</h2>
            <p>{short(myGoals[0]?.creator ?? '0xA8EaF49c1c33F987eFE883FdE72d4a1c243fB9EC')}</p>
          </div>
        </div>
        <div className="profile-stats">
          <div><span>won</span><b>{Math.max(0, total - 1)}</b></div>
          <div><span>completion</span><b>{total ? '80%' : '0%'}</b></div>
          <div><span>kept</span><b>{ethAtRisk ? `${ethAtRisk.toFixed(2)} ETH` : '0 ETH'}</b></div>
          <div><span>lost</span><b>0 ETH</b></div>
        </div>
      </section>
      <section className="tab-shell">
        <div className="section-head clean">
          <h2 className="section-title">recent history</h2>
        </div>
        {SOCIAL_ACTIVITY.slice(0, 3).map((item) => (
          <div className="history-row" key={item.body}><span>{item.badge}</span><p>{item.body}</p></div>
        ))}
        <WalletSettings />
      </section>
    </div>
  );
}

function ActiveMiniCard({ goal, isExample }: { goal: CreatedArgs; isExample: boolean }) {
  const cd = useCountdown(goal.deadline);
  return (
    <button className="active-mini-card">
      <span className="mini-label">{isExample ? 'example' : 'live'}</span>
      <h3>{goal.goalText}</h3>
      <p>{isExample ? `Josh gets your ${fmt(goal.amount)} ETH if you bail.` : `${short(goal.referee)} is watching`}</p>
      <div className="mini-foot">
        <b>{fmt(goal.amount)} ETH</b>
        <span>{cd.expired ? 'done' : cd.out}</span>
      </div>
    </button>
  );
}

function DisciplineHome({
  allGoals,
  myGoals,
  loadingGoals,
  onStart,
}: {
  allGoals?: CreatedArgs[];
  myGoals: CreatedArgs[];
  loadingGoals: boolean;
  onStart: () => void;
}) {
  const active = myGoals.filter((g) => Number(g.deadline) * 1000 > Date.now()).length;
  const ethAtRisk = myGoals.reduce((sum, g) => sum + Number(formatEther(g.amount)), 0);
  const displayGoals = myGoals.length ? myGoals : SAMPLE_ASSERTS.slice(0, 2);
  return (
    <div className="social-app fade-up">
      <section className="home-hero-card">
        <div>
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
          <b>{myGoals.length ? myGoals.length : 'soon'}</b>
        </div>
      </section>

      <section className="active-carousel">
        <div className="section-head clean">
          <h2 className="section-title">active asserts</h2>
          <span className="section-sub muted">what’s currently at risk</span>
        </div>
        <div className="active-scroll">
          {displayGoals.map((g) => <ActiveMiniCard key={g.id.toString()} goal={g} isExample={!myGoals.length} />)}
        </div>
      </section>

      <section className="activity-panel">
        <div className="section-head clean">
          <h2 className="section-title">friend activity</h2>
        </div>
        {SOCIAL_ACTIVITY.map((item) => (
          <button className={`activity-row ${item.action.replaceAll(' ', '-')}`} key={`${item.who}-${item.body}`} onClick={onStart}>
            <div className="avatar">{item.who[0]}</div>
            <div>
              <p><b>{item.who}</b> {item.action} <strong>{item.body}</strong></p>
              <span>{item.meta}</span>
            </div>
            <div className="activity-side">
              <b>{item.badge}</b>
              <span>♡ {item.reaction}</span>
            </div>
          </button>
        ))}
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

function BottomNav({ active, onSelect }: { active: AppMode; onSelect: (mode: AppMode) => void }) {
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

function GoalCard({ id }: { id: string }) {
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
    <div className="card goal fade-up-1">
      <div className="goal-top">
        <span className={`status s${status}`}>{STATUS_LABEL[status]}</span>
        <span className="muted">
          {isCreator ? 'you' : short(creator)} vs {isReferee ? 'you' : short(referee)}
        </span>
      </div>
      <p className="goal-text">{goalText}</p>
      <div className="goal-meta">
        <div className="pot">
          <b>{fmt(amount)}</b> <span>ETH pot</span>
        </div>
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

const SAMPLE_ASSERTS: CreatedArgs[] = [
  { id: 1n, creator: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72', referee: '0xA8EaF49c1c33F987eFE883FdE72d4a1c243fB9EC', goalText: 'no junk food for 30 days', amount: parseUnits('0.5', 18), deadline: BigInt(Math.floor(Date.now() / 1000) + 6 * 86400) },
  { id: 2n, creator: '0x48665B930a1c3DcE69C9D2d1d58E97f13F5F0c1', referee: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72', goalText: 'run a 5k every single morning', amount: parseUnits('0.25', 18), deadline: BigInt(Math.floor(Date.now() / 1000) + 2 * 86400) },
  { id: 3n, creator: '0xA8EaF49c1c33F987eFE883FdE72d4a1c243fB9EC', referee: '0x48665B930a1c3DcE69C9D2d1d58E97f13F5F0c1', goalText: 'read 20 pages a day, no excuses', amount: parseUnits('1', 18), deadline: BigInt(Math.floor(Date.now() / 1000) + 13 * 86400) },
  { id: 4n, creator: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72', referee: '0xA8EaF49c1c33F987eFE883FdE72d4a1c243fB9EC', goalText: 'cold plunge every morning for a month', amount: parseUnits('0.75', 18), deadline: BigInt(Math.floor(Date.now() / 1000) + 3 * 86400) },
  { id: 5n, creator: '0x48665B930a1c3DcE69C9D2d1d58E97f13F5F0c1', referee: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72', goalText: 'no doomscrolling before noon', amount: parseUnits('0.1', 18), deadline: BigInt(Math.floor(Date.now() / 1000) + 18 * 86400) },
].map((g, i) => ({ ...g, id: BigInt(9000 + i) })) as CreatedArgs[];

function TopAssertRow({ goal, rank, seeded }: { goal: CreatedArgs; rank: number; seeded: boolean }) {
  const cd = useCountdown(goal.deadline);
  return (
    <div className="feed-row fade-up-1">
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
  const src = goals && goals.length ? goals : SAMPLE_ASSERTS;
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
  const item = LANDING_ACTIVITY[1];
  return (
    <div className="landing-card-stack">
      <div className={`activity-row static hero-activity ${item.badge.toLowerCase()}`}>
        <div className="avatar">{item.who[0]}</div>
        <div>
          <p><b>{item.who}</b> <strong>{item.body}</strong></p>
          <span>{item.meta}</span>
        </div>
        <div className="activity-side"><b>{item.badge}</b></div>
      </div>
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
        <a href="https://base.org" target="_blank" rel="noreferrer">base.org</a>
      </div>
    </section>
  );
}

/* ---------------- app ---------------- */

export default function App() {
  const { isConnected, chainId, address } = useAccount();
  const [appMode, setAppMode] = useState<AppMode>('intro');
  const onKnownChain = chainId === 8453 || chainId === 84532;
  const { data: allGoals, isLoading: loadingGoals } = useAllCreated();

  // deep link: #g/<id>
  const [inviteId, setInviteId] = useState<string | null>(null);
  const invited = useMemo(() => {
    const m = window.location.hash.match(/^#g\/(\d+)$/);
    return m ? m[1] : null;
  }, []);

  const myGoals = (allGoals ?? []).filter(
    (g) => address && (g.creator === address || g.referee === address),
  );
  const invoked = invited ? (allGoals ?? []).find((g) => g.id.toString() === invited) : undefined;

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
            <LandingFinalCta />
          </main>
        </>
      ) : (
        <main>
          {invited ? (
            <GoalCard id={invited} />
          ) : null}

          {invited ? null : appMode === 'intro' ? (
            <ConnectedIntro onStart={() => setAppMode('home')} />
          ) : appMode === 'builder' ? (
            <div className="create-screen fade-up">
              {!onKnownChain && (
                <div className="banner action-warning">switch to <b>base</b> before locking an assert.</div>
              )}
              <CreateWizard onCreated={(id) => setInviteId(id > 0n ? id.toString() : null)} />
            </div>
          ) : appMode === 'asserts' ? (
            <AssertsTab myGoals={myGoals} />
          ) : appMode === 'friends' ? (
            <FriendsTab onStart={() => setAppMode('builder')} />
          ) : appMode === 'you' ? (
            <ProfileTab myGoals={myGoals} />
          ) : (
            <DisciplineHome
              allGoals={allGoals}
              myGoals={myGoals}
              loadingGoals={loadingGoals}
              onStart={() => setAppMode('builder')}
            />
          )}
          {inviteId ? (
            <ShareInvite
              id={BigInt(inviteId)}
              referee={invoked?.referee ?? '0x0'}
              onClose={() => setInviteId(null)}
            />
          ) : null}
          {appMode !== 'intro' && !invited ? <BottomNav active={appMode} onSelect={setAppMode} /> : null}
        </main>
      )}

      {isConnected ? <footer className="muted">assert — on your honor, onchain.</footer> : null}
    </div>
  );
}
