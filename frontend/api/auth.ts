import { createHmac } from 'node:crypto';
import { verifyMessage } from 'viem';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const TOKEN_TTL = 24 * 60 * 60;
const CHALLENGE_TTL = 5 * 60;

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');
const encode = (value: unknown) => base64url(JSON.stringify(value));

function mintJwt(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + TOKEN_TTL,
    auth_time: now,
  };
  const data = `${encode(header)}.${encode(payload)}`;
  const sig = createHmac('sha256', JWT_SECRET!).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export default async function handler(req: {
  method?: string;
  body?: { wallet?: unknown; message?: unknown; signature?: unknown };
}, res: {
  status: (code: number) => { json: (body: Record<string, unknown>) => void };
}) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!JWT_SECRET) {
    res.status(500).json({ error: 'server not configured' });
    return;
  }
  const { wallet, message, signature } = req.body ?? {};
  if (typeof wallet !== 'string' || typeof message !== 'string' || typeof signature !== 'string') {
    res.status(400).json({ error: 'wallet, message and signature are required' });
    return;
  }

  const match = /^assert sign-in (\d{10})$/.exec(message);
  if (!match) {
    res.status(400).json({ error: 'malformed message' });
    return;
  }
  const timestamp = Number(match[1]);
  if (Math.abs(Date.now() / 1000 - timestamp) > CHALLENGE_TTL) {
    res.status(401).json({ error: 'challenge expired' });
    return;
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: wallet as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    res.status(400).json({ error: 'could not verify signature' });
    return;
  }
  if (!valid) {
    res.status(401).json({ error: 'signature does not match wallet' });
    return;
  }

  const sub = wallet.toLowerCase();
  const token = mintJwt(sub);
  res.status(200).json({ token, expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL });
}