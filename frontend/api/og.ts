import { OG_STATIC_BASE64 } from './_lib/og-static.js';

const ogImage = Buffer.from(OG_STATIC_BASE64, 'base64');

export default async function handler(_req: unknown, res: {
  status: (code: number) => { send: (body: Buffer | string) => void };
  setHeader: (name: string, value: string) => void;
}) {
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  res.status(200).send(ogImage);
}
