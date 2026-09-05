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

function ConnectButton() {
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
        {isPending ? 'Connecting…' : 'Connect wallet'}
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
      <h2>Create a commitment</h2>
      <label>
        What are you asserting?
        <textarea name="goal" maxLength={280} rows={2} placeholder="No junk food for 30 days" />
      </label>
      <div className="row">
        <label>
          Stake
          <input name="stake" type="number" step="0.01" min="0.001" max="5" placeholder="0.5" />
        </label>
        <label>
          Deadline
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
        Referee wallet
        <input name="referee" placeholder="0x1234…" />
      </label>
      <button className="btn-primary" type="submit" disabled={isPending}>
        {isPending ? 'Locking…' : 'Lock it in. Assert it.'}
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

  if (isLoading) return <p className="muted">Loading your commitments…</p>;
  if (!goals?.length) return <p className="muted">No commitments yet — lock one in above.</p>;
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
            Accept role
          </button>
        )}
        {status === 0 && isCreator && (
          <button className="btn ghost" onClick={() => run('cancel')} disabled={isPending}>
            Cancel (refund)
          </button>
        )}
        {status === 1 && isReferee && (
          <button className="btn green" onClick={() => run('approve')} disabled={isPending}>
            ✓ They did it
          </button>
        )}
        {status === 1 && expired && (
          <button className="btn red" onClick={() => run('claimReferee')} disabled={isPending}>
            Referee earns stake
          </button>
        )}
        {status === 2 && <span className="muted">✓ Honored — stake returned</span>}
        {status === 3 && <span className="muted">✗ Humbled — referee earned it</span>}
        {status === 4 && <span className="muted">Cancelled — full refund</span>}
        {status === 1 && !expired && !isReferee && <span className="muted">Locked in — waiting on deadline</span>}
      </div>
    </div>
  );
}

export default function App() {
  const { isConnected, chainId } = useAccount();
  const onKnownChain = chainId === 8453 || chainId === 84532;

  return (
    <div className="page">
      <header>
        <div className="brand">
          <span className="mark">A</span>
          <span className="brand-name">Assert</span>
          <span className="tagline">Assert it. Or fold.</span>
        </div>
        <ConnectButton />
      </header>
      {!isConnected ? (
        <section className="hero">
          <h1>
            Stake money on your own goals.
            <br />
            Hit them — or a friend earns it.
          </h1>
          <p className="muted">
            Commitments enforced by code on Base. You set the stakes. A friend referees. No excuses.
          </p>
        </section>
      ) : (
        <main>
          {onKnownChain && <CreateGoalForm />}
          {!onKnownChain && (
            <div className="banner">
              Switch your wallet to the <b>Base network</b> to create a commitment.
            </div>
          )}
          <h2 className="section-title">Your commitments</h2>
          <Goals />
        </main>
      )}
      <footer className="muted">Assert — on your honor, onchain.</footer>
    </div>
  );
}