import { createPublicClient, formatEther, http } from 'viem';
import { base } from 'viem/chains';
import { commitmentAbi } from './_lib/commitment-abi.js';

const COMMITMENT_ADDRESS = '0x79E76B56318905E9A359E0Bda48816B47A6aB607';

const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });

type Goal = {
  title: string;
  amount: bigint;
  status: number;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function titleFromGoal(text: string) {
  return text.split('\n\nProof standard:')[0]?.trim() || 'I just made an assert';
}

async function readGoal(id: string): Promise<Goal | null> {
  if (!/^\d+$/.test(id)) return null;
  try {
    const result = await client.readContract({
      address: COMMITMENT_ADDRESS,
      abi: commitmentAbi,
      functionName: 'goals',
      args: [BigInt(id)],
    }) as readonly [string, string, string, bigint, bigint, bigint, number];
    if (result[0] === '0x0000000000000000000000000000000000000000') return null;
    return { title: titleFromGoal(result[2]), amount: result[3], status: Number(result[6]) };
  } catch {
    return null;
  }
}

export default async function handler(req: { query?: { id?: string }; headers?: { host?: string } }, res: {
  status: (code: number) => { send: (body: string) => void };
  setHeader: (name: string, value: string) => void;
}) {
  const id = String(req.query?.id ?? '');
  const host = req.headers?.host ?? 'useassert.app';
  const origin = `https://${host}`;
  const goal = await readGoal(id);
  const title = goal?.title ?? 'I just made an assert';
  const amount = goal ? `${formatEther(goal.amount)} ETH` : 'real stakes';
  const pageTitle = `Assert: ${title}`;
  const description = `Someone put ${amount} behind their word on Assert.`;
  const image = `${origin}/api/og?id=${encodeURIComponent(id)}`;
  const appUrl = `${origin}/g/${encodeURIComponent(id)}`;
  const fallback = `${origin}/#g/${encodeURIComponent(id)}`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(pageTitle)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(pageTitle)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(appUrl)}" />
    <meta property="og:image" content="${escapeHtml(image)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(image)}" />
  </head>
  <body>
    <p>Opening Assert…</p>
    <script>window.location.replace(${JSON.stringify(fallback)})</script>
  </body>
</html>`);
}
