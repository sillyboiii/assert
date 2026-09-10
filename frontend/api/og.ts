import sharp from 'sharp';
import { createPublicClient, formatEther, http } from 'viem';
import { base } from 'viem/chains';
import { commitmentAbi } from './_lib/commitment-abi.js';
import { FONT_BASE64, WORDMARK_BASE64 } from './_lib/og-assets.js';

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

function wrap(text: string, max: number, limit: number) {
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
  return lines.slice(0, limit);
}

function linesSvg(lines: string[], y: number, size: number, height: number) {
  return lines
    .map((line, i) => `<text x="0" y="${y + i * height}">${escapeXml(line)}</text>`)
    .join('');
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
  const headline = wrap('JUST MADE AN ASSERT', 16, 2);
  const titleLines = wrap(title, 15, 2);
  const due = goal?.deadline
    ? goal.deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()
    : 'soon';
  const amount = goal?.amount ?? '0.001';
  const badgeColor = '#405cff';

  const card = Buffer.from(`
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @font-face {
        font-family: 'Plus Jakarta Sans';
        font-weight: 900;
        src: url(data:font/ttf;base64,${FONT_BASE64}) format('truetype');
      }
      @font-face {
        font-family: 'Plus Jakarta Sans';
        font-weight: 800;
        src: url(data:font/ttf;base64,${FONT_BASE64}) format('truetype');
      }
    </style>
  </defs>
  <rect width="1200" height="630" fill="#f7f3ea"/>
  <image href="data:image/png;base64,${WORDMARK_BASE64}" x="72" y="64" width="181" height="60" preserveAspectRatio="xMinYMin meet"/>

  <g transform="translate(980 240) rotate(-5)" filter="drop-shadow(0 18px 30px rgba(64,92,255,0.18))">
    <rect x="-241" y="-260" width="482" height="520" rx="44" fill="#eceaeb"/>
    <g transform="translate(-210 -230)">
      <rect x="172" y="24" width="62" height="34" rx="17" fill="${badgeColor}"/>
      <text x="203" y="47" text-anchor="middle" fill="#fff" font-family="Plus Jakarta Sans" font-size="14.5" font-weight="900" letter-spacing="1.3">LIVE</text>
    </g>
  </g>

  <g transform="translate(75 300)" fill="#25214f" stroke="#25214f" stroke-width="1.4" paint-order="stroke fill" font-family="Plus Jakarta Sans" font-size="44" font-weight="900" letter-spacing="-1.2">
    ${linesSvg(headline, 0, 44, 52)}
  </g>

  <g transform="translate(75 424)" fill="#25214f" stroke="#25214f" stroke-width="1.2" paint-order="stroke fill" font-family="Plus Jakarta Sans" font-size="40" font-weight="900" letter-spacing="-1">
    ${linesSvg(titleLines, 0, 40, 48)}
  </g>

  <g transform="translate(75 500)">
    <text fill="#6e6a8a" stroke="#6e6a8a" stroke-width="0.45" paint-order="stroke fill" font-family="Plus Jakarta Sans" font-size="24" font-weight="800">${escapeXml(amount)} ETH on the line · friend referees · due ${escapeXml(due)}</text>
  </g>
</svg>`);
  const image = await sharp(card)
    .png()
    .toBuffer();

  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  res.status(200).send(image);
}
