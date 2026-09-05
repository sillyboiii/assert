import { useQuery } from '@tanstack/react-query';
import { getAbiItem, parseUnits, formatEther } from 'viem';
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

const short = (a: `0x${string}` | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmt = (w: bigint) => `${Number(formatEther(w)).toFixed(3)} ETH`;

function SplitMark({ size = 28, bare = false }: { size?: number; bare?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      {!bare && (
        <rect x="1" y="1" width="62" height="62" rx="18" fill="#E9E7FA" stroke="#E5E0F4" strokeWidth="2" />
      )}
      <path d="M17 45 L31 20" stroke="#6965E8" strokeWidth="10" strokeLinecap="round" />
      <path d="M33 20 L47 45" stroke="#25214F" strokeWidth="10" strokeLinecap="round" />
      <path d="M21.5 38 H28" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" />
      <path d="M36 38 H42.5" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

function ConnectButton({ label = 'Connect wallet' }: { label?: string }) {
  const { isConnected, address } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <button className="chip" onClick={() => disconnect()}>
        {short(address)} · disconnect
      </button>
    );
  }
  const connector = connectors.find((c) => c.id === 'coinbaseWalletSDK') ?? connectors[0];
  const demo = connectors.find((c) => c.id === 'mock');
  return (
    <div className="conn-row">
      <button className="btn-primary" onClick={() => connect({ connector })} disabled={isPending}>
        {isPending ? 'Connecting…' : label}
      </button>
      {demo && (
        <button className="btn ghost" onClick={() => connect({ connector: demo })} disabled={isPending}>
          Demo wallet
        </button>
      )}
    </div>
  );
}

function CreateGoalForm() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  if (!address) return null;
  return (
    <form
      className="card create-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const goalText = String(f.get('goal') ?? '').trim();
        const referee = String(f.get('referee') ?? '').trim() as `0x${string}`;
        const days = Number(f.get('days'));
        const stake = String(f.get('stake') ?? '0');
        if (!goalText || !referee || !days || !stake) return;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
        const hash = await writeContractAsync({
          address: COMMITMENT_ADDRESS,
          abi: commitmentAbi,
          functionName: 'createGoal',
          args: [goalText, referee, deadline],
          value: parseUnits(stake, 18),
        });
        await waitForTx(hash);
        window.location.reload();
      }}
    >
      <h2>new commitment</h2>
      <label>
        what are you asserting?
        <textarea name="goal" maxLength={280} rows={2} placeholder="no junk food for 30 days…" />
      </label>
      <div className="row">
        <label>
          stake (eth)
          <input name="stake" type="number" step="0.01" min="0.001" max="5" placeholder="0.5" />
        </label>
        <label>
          deadline
          <select name="days" defaultValue="7">
            <option value="1">1 day</option>
            <option value="3">3 days</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
          </select>
        </label>
      </div>
      <label>
        referee wallet
        <input name="referee" placeholder="0x1234…" />
      </label>
      <button className="btn-primary" type="submit" disabled={isPending}>
        {isPending ? 'locking…' : 'lock it in. assert it.'}
      </button>
    </form>
  );
}

function Goals() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const createdEvent = getAbiItem({ abi: commitmentAbi, name: 'Created' });

  const { data: goals, isLoading } = useQuery({
    queryKey: ['myGoals', address, chainId],
    enabled: !!address && !!publicClient,
    queryFn: async () => {
      const logs = await publicClient!.getLogs({
        address: COMMITMENT_ADDRESS,
        event: createdEvent,
        fromBlock: 0n,
        toBlock: 'latest',
      });
      const args = logs
        .map((l) => l.args as CreatedArgs)
        .filter((a) => a.creator === address || a.referee === address)
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      return args;
    },
    refetchInterval: 15_000,
  });

  if (isLoading) return <p className="muted">loading your commitments…</p>;
  if (!goals?.length) return <p className="muted">no commitments yet — lock one in above.</p>;
  return (
    <div className="goal-grid">
      {goals.map((g) => (
        <GoalCard key={g.id.toString()} created={g} />
      ))}
    </div>
  );
}

function GoalCard({ created }: { created: CreatedArgs }) {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  const { data } = useReadContract({
    address: COMMITMENT_ADDRESS,
    abi: commitmentAbi,
    functionName: 'goals',
    args: [created.id],
  });
  const raw = data as GoalStruct | undefined;
  if (!raw) return null;

  const [creator, referee, goalText, amount, _fee, deadline, status] = raw;
  const isCreator = address === creator;
  const isReferee = address === referee;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expired = now > deadline;
  const daysLeft = Math.max(0, Number((deadline - now) / 86400n));

  const run = async (functionName: 'acceptRole' | 'approve' | 'cancel' | 'claimReferee') => {
    const hash = await writeContractAsync({
      address: COMMITMENT_ADDRESS,
      abi: commitmentAbi,
      functionName,
      args: [created.id],
    });
    await waitForTx(hash);
    window.location.reload();
  };

  return (
    <div className="card goal">
      <div className="goal-top">
        <span className={`status s${status}`}>{STATUS_LABEL[status]}</span>
        <span className="muted">{short(creator)}</span>
      </div>
      <p className="goal-text">{goalText}</p>
      <div className="goal-meta">
        <span>
          <b>{fmt(amount)}</b> locked
        </span>
        <span>{expired ? 'deadline passed' : `~${daysLeft}d left`}</span>
      </div>
      <div className="goal-actions">
        {status === 0 && isReferee && (
          <button className="btn" onClick={() => run('acceptRole')} disabled={isPending}>
            accept role
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
        {status === 2 && <span className="muted">✓ honored — stake returned</span>}
        {status === 3 && <span className="muted">✗ humbled — referee earned it</span>}
        {status === 4 && <span className="muted">cancelled — full refund</span>}
        {status === 1 && !expired && !isReferee && <span className="muted">locked in — waiting on deadline</span>}
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    { n: '01', title: 'you stake', body: 'lock real eth on a goal that actually matters to you.' },
    { n: '02', title: 'a friend referees', body: 'they accept the role and verify the truth when the clock runs out.' },
    { n: '03', title: 'the deadline decides', body: 'hit it, your stake comes back. miss it, your friend takes the pot.' },
  ];
  return (
    <section className="steps" aria-label="how it works">
      {steps.map((s) => (
        <div className="step" key={s.n}>
          <span className="step-num">{s.n}</span>
          <h3>{s.title}</h3>
          <p>{s.body}</p>
        </div>
      ))}
    </section>
  );
}

export default function App() {
  const { isConnected, chainId } = useAccount();
  const onKnownChain = chainId === 8453 || chainId === 84532;

  return (
    <div className="page">
      <header>
        <div className="brand">
          <span className="mark">
            <SplitMark size={44} />
          </span>
          <span className="brand-stack">
            <span className="brand-name">assert</span>
            <span className="tagline">assert it. or fold.</span>
          </span>
        </div>
        <ConnectButton />
      </header>
      {!isConnected ? (
        <section className="hero">
          <div className="hero-accent">
            <SplitMark size={460} bare />
          </div>
          <div className="hero-inner">
            <h1>
              assert it,
              <br />
              or fold.
            </h1>
            <p className="lead">
              stake money on your own goals. a friend referees the truth. hit the deadline and it's yours —
              miss it and they take it home. enforced by code on base, no excuses.
            </p>
            <div className="hero-cta">
              <ConnectButton label="connect wallet to start" />
            </div>
            <HowItWorks />
          </div>
        </section>
      ) : (
        <main>
          {onKnownChain && <CreateGoalForm />}
          {!onKnownChain && (
            <div className="banner">
              switch your wallet to the <b>base network</b> to create a commitment.
            </div>
          )}
          <h2 className="section-title">your commitments</h2>
          <Goals />
        </main>
      )}
      <footer className="muted">assert — on your honor, onchain.</footer>
    </div>
  );
}