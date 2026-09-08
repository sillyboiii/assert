import { awaitAuthToken, clearAuthToken, ensureAuthToken } from './auth.ts';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export type StoredProfile = {
  wallet_address: string;
  username: string;
  pfp_url: string;
  locked: boolean;
};

export type StoredPreferences = {
  wallet_address: string;
  dismissed_request_ids: string[];
  hidden_friend_addresses: string[];
};

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T | undefined> {
  if (!hasSupabase) return undefined;
  let token = await ensureAuthToken();
  if (!token) token = await awaitAuthToken();
  if (!token) return undefined;
  const headers = new Headers({
    apikey: SUPABASE_ANON_KEY!,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers,
  });
  if (response.status === 401 || response.status === 403) {
    clearAuthToken();
    if (!retried) return request<T>(path, init, true);
  }
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  return response.status === 204 ? undefined : ((await response.json()) as T);
}

export async function readStoredProfile(walletAddress: string) {
  const rows = await request<StoredProfile[]>(
    `profiles?wallet_address=eq.${encodeURIComponent(walletAddress.toLowerCase())}&select=*`,
  );
  return rows?.[0];
}

export async function saveStoredProfile(profile: StoredProfile) {
  const rows = await request<StoredProfile[]>('profiles?on_conflict=wallet_address', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ ...profile, wallet_address: profile.wallet_address.toLowerCase() }),
  });
  return rows?.[0];
}

export async function readStoredPreferences(walletAddress: string) {
  const rows = await request<StoredPreferences[]>(
    `user_preferences?wallet_address=eq.${encodeURIComponent(walletAddress.toLowerCase())}&select=*`,
  );
  return rows?.[0];
}

export async function saveStoredPreferences(preferences: StoredPreferences) {
  const rows = await request<StoredPreferences[]>('user_preferences?on_conflict=wallet_address', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      ...preferences,
      wallet_address: preferences.wallet_address.toLowerCase(),
      hidden_friend_addresses: preferences.hidden_friend_addresses.map((a) => a.toLowerCase()),
    }),
  });
  return rows?.[0];
}