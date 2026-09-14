/// <reference types="node" />

import sharp from 'sharp';
import { existsSync, writeFileSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { createPublicClient, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { commitmentAbi } from './_lib/commitment-abi.js';
import { commitmentV2Abi } from './_lib/commitment-v2-abi.js';
import { FONT_BASE64 } from './_lib/og-assets.js';
import { ogTemplatePng } from './_lib/og-template.js';

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
  const source = id.startsWith('v2-') ? 'v2' : 'v1';
  const rawId = id.startsWith('v2-') ? id.slice(3) : id;
  if (!/^\d+$/.test(rawId)) return null;
  const v2Address = process.env.COMMITMENT_V2_ADDRESS || process.env.VITE_COMMITMENT_V2_ADDRESS;
  if (source === 'v2' && !v2Address) return null;
  try {
    const address = source === 'v2' ? (v2Address as `0x${string}`) : COMMITMENT_ADDRESS;
    const abi = source === 'v2' ? commitmentV2Abi : commitmentAbi;
    const result = await client.readContract({
      address,
      abi,
      functionName: 'goals',
      args: [BigInt(rawId)],
    });
    if (source === 'v2') {
      const v2 = result as readonly [string, string, string, string, bigint, bigint, bigint, number];
      if (v2[0] === '0x0000000000000000000000000000000000000000') return null;
      return {
        title: titleFromGoal(v2[3]),
        amount: formatUnits(v2[4], 6),
        unit: 'USDC',
        deadline: new Date(Number(v2[6]) * 1000),
        status: STATUS[Number(v2[7])] ?? 'ASSERTED',
      };
    }
    const v1 = result as readonly [string, string, string, bigint, bigint, bigint, number];
    if (v1[0] === '0x0000000000000000000000000000000000000000') return null;
    return {
      title: titleFromGoal(v1[2]),
      amount: formatUnits(v1[3], 18),
      unit: 'ETH',
      deadline: new Date(Number(v1[5]) * 1000),
      status: STATUS[Number(v1[6])] ?? 'ASSERTED',
    };
  } catch {
    return null;
  }
}

async function readCleanedTemplate(): Promise<Buffer> {
  return sharp(ogTemplatePng).png().toBuffer();
}

let registeredFont = false;

function ensureFont() {
  if (registeredFont) return;
  const path = '/tmp/assert-og-plus-jakarta.ttf';
  if (!existsSync(path)) writeFileSync(path, Buffer.from(FONT_BASE64, 'base64'));
  GlobalFonts.registerFromPath(path, 'Plus Jakarta Sans');
  registeredFont = true;
}

function roundedRect(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawCard({ title, amount, unit, due }: { title: string; amount: string; unit: string; due: string }) {
  ensureFont();
  const canvas = createCanvas(1200, 630);
  const ctx = canvas.getContext('2d');
  const badgeColor = '#405cff';
  const lines = wrap(title);

  ctx.save();
  ctx.translate(592 + 250, 216 + 105);
  ctx.rotate((6.5 * Math.PI) / 180);
  ctx.translate(-250, -105);

  ctx.shadowColor = 'rgba(64, 92, 255, 0.15)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 16;
  roundedRect(ctx, -36, -36, 572, 282, 40);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  roundedRect(ctx, 0, 0, 500, 210, 29);
  ctx.save();
  ctx.clip();
  const gradient = ctx.createLinearGradient(0, 0, 0, 210);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(1, '#f8fafc');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 500, 210);
  ctx.fillStyle = badgeColor;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(0, 0, 500, 5);
  ctx.globalAlpha = 1;
  ctx.restore();
  roundedRect(ctx, 0, 0, 500, 210, 29);
  ctx.strokeStyle = '#dce3ff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  roundedRect(ctx, 28, 25, 114, 34, 17);
  ctx.fillStyle = badgeColor;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 14.5px "Plus Jakarta Sans"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('LIVE', 85, 48);

  ctx.fillStyle = '#081046';
  ctx.font = '900 23px "Plus Jakarta Sans"';
  ctx.textAlign = 'left';
  ctx.fillText(`${amount} ${unit}`, 164, 49);

  ctx.fillStyle = '#071044';
  ctx.font = '900 30px "Plus Jakarta Sans"';
  for (const [i, line] of lines.entries()) ctx.fillText(line, 28, 94 + i * 34);

  ctx.fillStyle = '#747bad';
  ctx.font = '800 17px "Plus Jakarta Sans"';
  ctx.fillText(`friend referees · due ${due}`, 28, 178);

  ctx.restore();
  return canvas.toBuffer('image/png');
}

export default async function handler(req: { query?: { id?: string } }, res: {
  status: (code: number) => { send: (body: Buffer | string) => void };
  setHeader: (name: string, value: string) => void;
}) {
  const goal = await readGoal(String(req.query?.id ?? ''));
  const title = goal?.title ?? 'wake up before 7am every day';
  const due = goal?.deadline
    ? goal.deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()
    : 'soon';
  const card = drawCard({ title, amount: goal?.amount ?? (goal?.unit === 'USDC' ? '1' : '0.001'), unit: goal?.unit ?? 'ETH', due });
  const cleaned = await readCleanedTemplate();
  const image = await sharp(cleaned)
    .resize(1200, 630, { fit: 'contain', background: '#f8fbff' })
    .composite([{ input: card }])
    .png()
    .toBuffer();

  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  res.status(200).send(image);
}
