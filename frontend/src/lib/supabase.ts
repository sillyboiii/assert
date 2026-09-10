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
  followed_goal_ids: string[];
};

export type StoredRefereeDenial = {
  goal_id: string;
  creator_wallet: string;
  referee_wallet: string;
  created_at?: string;
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

export async function readStoredProfiles(walletAddresses: string[]) {
  const list = [...new Set(walletAddresses.map((a) => a.toLowerCase()))];
  if (!list.length || !hasSupabase) return [];
  const filter = `wallet_address=in.(${list.map((a) => `"${a}"`).join(',')})`;
  const rows = await request<StoredProfile[]>(`profiles?${encodeURIComponent(filter)}&select=*`);
  return rows ?? [];
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
      followed_goal_ids: preferences.followed_goal_ids,
    }),
  });
  return rows?.[0];
}

export async function readRefereeDenials(walletAddress: string) {
  const wallet = walletAddress.toLowerCase();
  const filter = `(creator_wallet.eq.${wallet},referee_wallet.eq.${wallet})`;
  const rows = await request<StoredRefereeDenial[]>(
    `referee_denials?or=${encodeURIComponent(filter)}&select=*`,
  );
  return rows ?? [];
}

export async function saveRefereeDenial(denial: Omit<StoredRefereeDenial, 'created_at'>) {
  const rows = await request<StoredRefereeDenial[]>('referee_denials?on_conflict=goal_id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      goal_id: denial.goal_id,
      creator_wallet: denial.creator_wallet.toLowerCase(),
      referee_wallet: denial.referee_wallet.toLowerCase(),
    }),
  });
  if (!rows?.[0]) throw new Error('Referee denial not saved');
  return rows[0];
}
