const TOKEN_KEY = 'assert-auth-token';
const TOKEN_TTL = 24 * 60 * 60;

export type AuthToken = {
  token: string;
  expiresAt: number;
};

let mintHook: (() => Promise<string | null>) | null = null;
let minting: Promise<string | null> | null = null;
const readyListeners = new Set<() => void>();

function notifyReady() {
  for (const listener of readyListeners) listener();
}

export function onAuthReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

export async function awaitAuthToken(timeoutMs = 12000): Promise<string | null> {
  const existing = await ensureAuthToken();
  if (existing) return existing;
  return new Promise<string | null>((resolve) => {
    const off = onAuthReady(() => {
      off();
      resolve(ensureAuthToken());
    });
    setTimeout(() => {
      off();
      resolve(ensureAuthToken());
    }, timeoutMs);
  });
}

export function setMintHook(hook: (() => Promise<string | null>) | null) {
  mintHook = hook;
  minting = null;
}

export function clearAuthToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function readStored(): AuthToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthToken;
    if (!parsed?.token || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function storeToken(token: string, expiresAt: number) {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  } catch {
    /* ignore */
  }
}

export function ensureAuthToken(): Promise<string | null> {
  const stored = readStored();
  if (stored && stored.expiresAt > Date.now() / 1000 + 60) return Promise.resolve(stored.token);
  if (stored) clearAuthToken();
  if (!mintHook) return Promise.resolve(null);
  if (!minting) {
    minting = mintHook()
      .then((token) => {
        minting = null;
        if (token) notifyReady();
        return token;
      })
      .catch((error) => {
        minting = null;
        throw error;
      });
  }
  return minting;
}

export async function mintAuthToken(
  signMessage: (message: string) => Promise<`0x${string}`>,
  wallet: `0x${string}`,
): Promise<string | null> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `assert sign-in ${timestamp}`;
  const signature = await signMessage(message);
  const response = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, message, signature }),
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; expiresAt?: number; error?: string };
  if (!response.ok || !body.token || !body.expiresAt) {
    throw new Error(body.error ?? `auth failed (${response.status})`);
  }
  storeToken(body.token, body.expiresAt);
  return body.token;
}

export { TOKEN_KEY, TOKEN_TTL };