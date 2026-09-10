import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const font = readFileSync('/tmp/pjs-600.ttf').toString('base64');
const wordmark = readFileSync(new URL('../public/wordmark.png', import.meta.url)).toString('base64');

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @font-face {
        font-family: 'Plus Jakarta Sans';
        src: url(data:font/ttf;base64,${font}) format('truetype');
        font-weight: 800;
      }
    </style>
  </defs>
  <rect width="1200" height="630" fill="#f7f3ea"/>
  <image href="data:image/png;base64,${wordmark}" x="72" y="64" width="181" height="60" preserveAspectRatio="xMinYMin meet"/>

  <g transform="translate(980 240) rotate(-5)">
    <rect x="-241" y="-260" width="482" height="520" rx="44" fill="#eceaeb"/>
  </g>

  <g fill="#25214f" font-family="Plus Jakarta Sans" font-weight="800" letter-spacing="-1.15">
    <text x="75" y="314" font-size="45">JUST MADE</text>
    <text x="75" y="370" font-size="45">AN ASSERT</text>
    <text x="75" y="430" font-size="40">train 4x a week</text>
    <text x="75" y="480" font-size="40">for 30 days</text>
  </g>

  <text x="75" y="535" fill="#6e6a8a" font-family="Plus Jakarta Sans" font-size="24" font-weight="800">0.001 ETH on the line · friend referees · due sep 11</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(new URL('../public/og.png', import.meta.url), png);
writeFileSync('/tmp/og-regenerated.png', png);
console.log(png.length);
