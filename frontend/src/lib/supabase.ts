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

const headers = () => ({
  apikey: SUPABASE_ANON_KEY!,
  authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'content-type': 'application/json',
});

async function request<T>(path: string, init?: RequestInit): Promise<T | undefined> {
  if (!hasSupabase) return undefined;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(), ...init?.headers },
  });
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
