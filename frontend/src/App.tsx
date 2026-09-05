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
        <span className="eyebrow">identity check</span>
        <h3>who are you trying to become?</h3>
        <p className="muted">make the promise specific enough that your referee can call it without drama.</p>
      </div>
      <label>
        your assert
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
      <label className="proof-label">
        proof standard
        <div className="textarea-shell">
          <textarea
            className="goal-input proof-input"
            name="proof"
            maxLength={180}
            rows={2}
            placeholder="what evidence should your referee expect?"
            value={proof}
            onChange={(e) => setProof(e.target.value)}
          />
          <span className="char-count">{proof.length}/180</span>
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
              setProof(t.proof);
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
        who referees the truth?
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
        <span>💌 tip: use their ens or a wallet address</span>
        <span>🔗 we'll ping you a shareable invite after you lock it in</span>
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
        <span className="eyebrow">pressure setting</span>
        <h3>how expensive should folding be?</h3>
        <p className="muted">pick a mode or type your own stake. bigger pot, louder promise.</p>
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
        how much are you putting up? (eth)
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
        how long are you held to it?
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
      <span className="eyebrow">final check</span>
      <h3>read this like a contract with yourself.</h3>
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

  const stepsLabel = ['identity', 'referee', 'pressure', 'review'];
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
      ? goal.trim().length > 0 && proof.trim().length > 0
      : step === 1
        ? refereeResult.ok && !refereeResult.ensOnly
        : step === 2
          ? parseFloat(stake) >= 0.001
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

      {step === 0 && <Step1Goal goal={goal} setGoal={setGoal} proof={proof} setProof={setProof} />}
      {step === 1 && <Step2Referee value={referee} onChange={setReferee} onResolved={setResolvedReferee} />}
      {step === 2 && (
        <Step3Stake
          stake={stake}
          setStake={setStake}
          days={days}
          setDays={setDays}
          intensity={intensity}
          setIntensity={setIntensity}
        />
      )}
      {step === 3 && <Step4Review goal={goal} proof={proof} referee={refereeResult.addr ?? referee} stake={stake} days={days} />}

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

function DisciplineHome({
  allGoals,
  myGoals,
  loadingGoals,
  onStart,
  onReplayIntro,
}: {
  allGoals?: CreatedArgs[];
  myGoals: CreatedArgs[];
  loadingGoals: boolean;
  onStart: () => void;
  onReplayIntro: () => void;
}) {
  const active = myGoals.filter((g) => Number(g.deadline) * 1000 > Date.now()).length;
  const ethAtRisk = myGoals.reduce((sum, g) => sum + Number(formatEther(g.amount)), 0);
  return (
    <div className="discipline-home fade-up">
      <section className="identity-card">
        <span className="eyebrow">today’s identity</span>
        <h2>the version of you that follows through.</h2>
        <p>don’t write another note to yourself. make a public promise, assign a referee, and price the excuse.</p>
        <div className="identity-actions">
          <button className="btn-primary" onClick={onStart}>start a serious assert →</button>
          <button className="btn ghost" onClick={onReplayIntro}>replay intro</button>
        </div>
      </section>

      <section className="status-grid" aria-label="discipline status">
        <div className="status-card"><span>active asserts</span><b>{active}</b></div>
        <div className="status-card"><span>eth at risk</span><b>{ethAtRisk ? ethAtRisk.toFixed(3).replace(/\.?0+$/, '') : '0'}</b></div>
        <div className="status-card"><span>referee queue</span><b>{myGoals.filter((g) => g.referee).length}</b></div>
        <div className="status-card"><span>streak</span><b>starts today</b></div>
      </section>

      <section className="start-zone">
        <span className="eyebrow">start zone</span>
        <h3>what are you done letting slide?</h3>
        <div className="start-options">
          <button onClick={onStart}>break a bad habit</button>
          <button onClick={onStart}>build a new one</button>
          <button onClick={onStart}>ship something</button>
          <button onClick={onStart}>custom assert</button>
        </div>
      </section>

      <section className="app-panel your-panel">
        <div className="section-head">
          <h2 className="section-title">your asserts</h2>
          <span className="section-sub muted">personal pressure log</span>
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
          <p className="empty-copy">nothing active yet. clean slate, dangerous moment.</p>
        )}
      </section>

      <section className="app-panel top-panel">
        <div className="section-head">
          <h2 className="section-title">top asserts</h2>
          <span className="section-sub muted">biggest pots on-chain</span>
        </div>
        <TopAsserts goals={allGoals} limit={6} seeded />
      </section>
    </div>
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

function TopAsserts({ goals, limit = 8, seeded = false }: { goals?: CreatedArgs[]; limit?: number; seeded?: boolean }) {
  const src = goals && goals.length ? goals : SAMPLE_ASSERTS;
  const sorted = useMemo(() => [...src].sort((a, b) => (a.amount < b.amount ? 1 : -1)), [src]);
  const rows = sorted.slice(0, limit);
  return (
    <div className="feed-list">
      {rows.map((g, i) => {
        const cd = useCountdown(g.deadline);
        return (
          <div className="feed-row fade-up-1" key={g.id.toString()}>
            <span className={`feed-rank${i < 3 ? ' top' : ''}`}>
              {['🥇', '🥈', '🥉'][i] ?? `#${i + 1}`}
            </span>
            <div className="feed-main">
              <div className="feed-goal">{g.goalText}</div>
              <div className="feed-meta">
                {seeded && !goals?.length ? 'someone on base' : short(g.creator)} → vs{' '}
                {seeded && !goals?.length ? 'their referee' : short(g.referee)}
              </div>
            </div>
            <span className="feed-amount">{fmt(g.amount)} ETH</span>
            <span className={`feed-countdown${cd.urgent && !cd.expired ? ' urgent' : ''}`}>
              {cd.expired ? 'done' : cd.out}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- landing ---------------- */

function HowItWorks() {
  const steps = [
    { n: '01', title: 'you stake', body: 'lock real eth on a goal that actually matters to you.' },
    { n: '02', title: 'a friend referees', body: 'they accept the role and verify the truth when the clock runs out.' },
    { n: '03', title: 'the deadline decides', body: 'hit it, your stake comes back. miss it, your friend takes the pot.' },
  ];
  return (
    <section className="steps" aria-label="how it works">
      {steps.map((s, i) => (
        <div className={`step fade-up-${(i % 4) + 1}`} key={s.n}>
          <span className="step-num">{s.n}</span>
          <h3>{s.title}</h3>
          <p>{s.body}</p>
        </div>
      ))}
    </section>
  );
}

/* ---------------- app ---------------- */

export default function App() {
  const { isConnected, chainId, address } = useAccount();
  const [appMode, setAppMode] = useState<'intro' | 'home' | 'builder'>('intro');
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
    <div className="page">
      <div className="aurora" aria-hidden="true" />
      <header>
        <ConnectButton />
      </header>

      {!isConnected ? (
        <>
          <section className="hero">
            <div className="hero-inner">
              <img className="hero-wordmark fade-up" src="/wordmark.png" alt="assert" />
              <h1 className="fade-up fade-up-1">assert it, or fold.</h1>
              <p className="lead fade-up fade-up-2">
                stake money on your own goals. a friend referees the truth. hit the deadline and
                it's yours — miss it and they take it home. enforced by code on base, no excuses.
              </p>
            </div>
          </section>

          <HowItWorks />
        </>
      ) : (
        <main>
          {invited ? (
            <GoalCard id={invited} />
          ) : null}
          {!onKnownChain && (
            <div className="banner">switch your wallet to the <b>base network</b> to create or act on asserts.</div>
          )}

          {invited ? null : appMode === 'intro' ? (
            <ConnectedIntro onStart={() => setAppMode('home')} />
          ) : appMode === 'builder' ? (
            <CreateWizard onCreated={(id) => setInviteId(id > 0n ? id.toString() : null)} />
          ) : (
            <DisciplineHome
              allGoals={allGoals}
              myGoals={myGoals}
              loadingGoals={loadingGoals}
              onStart={() => setAppMode('builder')}
              onReplayIntro={() => setAppMode('intro')}
            />
          )}
          {inviteId ? (
            <ShareInvite
              id={BigInt(inviteId)}
              referee={invoked?.referee ?? '0x0'}
              onClose={() => setInviteId(null)}
            />
          ) : null}
        </main>
      )}

      <footer className="muted">assert — on your honor, onchain.</footer>
    </div>
  );
}
