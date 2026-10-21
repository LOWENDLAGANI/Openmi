import { getAuth } from 'firebase/auth';

async function token(): Promise<string> {
  const user = getAuth().currentUser;
  if (!user) throw new Error('not signed in');
  return user.getIdToken();
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error?.code, body.error?.message);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new ApiError(res.status, b.error?.code, b.error?.message);
  }
  return res.json();
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code?: string, message?: string) {
    super(message ?? `API error ${status}`);
    this.status = status;
    this.code = code;
  }
}
