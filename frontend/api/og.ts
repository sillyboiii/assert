import sharp from 'sharp';
import { createPublicClient, formatEther, http } from 'viem';
import { base } from 'viem/chains';
import { commitmentAbi } from './_lib/commitment-abi.js';

const COMMITMENT_ADDRESS = '0x79E76B56318905E9A359E0Bda48816B47A6aB607';

const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });

const STATUS: Record<number, string> = {
  0: 'PENDING',
  1: 'LIVE',
  2: 'WON',
  3: 'FOLDED',
  4: 'CANCELLED',
};

function titleFromGoal(text: string) {
  return text.split('\n\nProof standard:')[0]?.trim() || 'I just made an assert';
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrap(text: string, max = 27) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

async function readGoal(id: string) {
  if (!/^\d+$/.test(id)) return null;
  try {
    const result = await client.readContract({
      address: COMMITMENT_ADDRESS,
      abi: commitmentAbi,
      functionName: 'goals',
      args: [BigInt(id)],
    }) as readonly [string, string, string, bigint, bigint, bigint, number];
    if (result[0] === '0x0000000000000000000000000000000000000000') return null;
    return {
      title: titleFromGoal(result[2]),
      amount: formatEther(result[3]),
      deadline: new Date(Number(result[5]) * 1000),
      status: STATUS[Number(result[6])] ?? 'ASSERTED',
    };
  } catch {
    return null;
  }
}

export default async function handler(req: { query?: { id?: string } }, res: {
  status: (code: number) => { send: (body: Buffer | string) => void };
  setHeader: (name: string, value: string) => void;
}) {
  const goal = await readGoal(String(req.query?.id ?? ''));
  const title = goal?.title ?? 'wake up before 7am every day';
  const lines = wrap(title);
  const due = goal?.deadline
    ? goal.deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()
    : 'soon';
  const badgeColor = '#405cff';
  const lineSvg = lines
    .map((line, i) => `<text x="0" y="${i * 34}">${escapeXml(line)}</text>`)
    .join('');
  const card = Buffer.from(`
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f8fafc"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-30%" width="140%" height="170%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#405cff" flood-opacity="0.15"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="#f8fbff"/>
  <circle cx="150" cy="60" r="180" fill="#eef3ff" opacity="0.6"/>
  <circle cx="1080" cy="520" r="220" fill="#eef3ff" opacity="0.7"/>
  <g transform="translate(592 216) rotate(6.5 250 105)" filter="url(#shadow)">
    <rect x="-36" y="-36" width="572" height="282" rx="40" fill="#ffffff"/>
    <clipPath id="cardClip"><rect width="500" height="210" rx="29"/></clipPath>
    <g clip-path="url(#cardClip)">
      <rect width="500" height="210" rx="29" fill="url(#cardBg)" stroke="#dce3ff" stroke-width="1.5"/>
      <rect width="500" height="5" y="0" fill="${badgeColor}" opacity="0.9"/>
    </g>
    <g transform="translate(28 25)">
      <rect width="114" height="34" rx="17" fill="${badgeColor}"/>
      <text x="57" y="23" text-anchor="middle" fill="#fff" font-family="Arial, sans-serif" font-size="14.5" font-weight="900" letter-spacing="1.3">LIVE</text>
      <text x="136" y="24" fill="#081046" font-family="Arial, sans-serif" font-size="23" font-weight="900">${escapeXml(goal?.amount ?? '0.001')} ETH</text>
    </g>
    <g transform="translate(28 94)" fill="#071044" font-family="Arial, sans-serif" font-size="30" font-weight="900" letter-spacing="-1.2">
      ${lineSvg}
    </g>
    <g transform="translate(28 178)">
      <text fill="#747bad" font-family="Arial, sans-serif" font-size="17" font-weight="800">friend referees · due ${escapeXml(due)}</text>
    </g>
  </g>
</svg>`);
  const image = await sharp(card)
    .png()
    .toBuffer();

  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  res.status(200).send(image);
}
