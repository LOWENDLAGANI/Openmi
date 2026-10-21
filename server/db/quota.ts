import { firestore } from '../firebase.js';
import { AppError } from '../errors.js';

// usage_daily docs: id = `${uid}:${YYYY-MM-DD}` (UTC).
// consumeTaskQuota runs check-and-increment inside a single Firestore
// transaction so the daily budget is race-free.

export function dayKey(ts = Date.now()): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface QuotaResult {
  used: number;
  limit: number;
  remaining: number;
}

export async function consumeTaskQuota(uid: string, limit: number): Promise<QuotaResult> {
  const id = `${uid}:${dayKey()}`;
  const ref = firestore().collection('usage_daily').doc(id);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = (snap.data()?.count as number | undefined) ?? 0;
    if (used >= limit) {
      throw new AppError('QUOTA_EXCEEDED', `daily task limit (${limit}) reached`, {
        details: { limit, used },
      });
    }
    tx.set(ref, { count: used + 1, uid, day: dayKey(), updatedAt: new Date() }, { merge: true });
    return { used: used + 1, limit, remaining: limit - (used + 1) };
  });
}

export async function refundTaskQuota(uid: string): Promise<void> {
  const id = `${uid}:${dayKey()}`;
  const ref = firestore().collection('usage_daily').doc(id);
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = (snap.data()?.count as number | undefined) ?? 0;
    if (used > 0) {
      tx.set(ref, { count: used - 1, updatedAt: new Date() }, { merge: true });
    }
  });
}

export async function getUsageToday(uid: string): Promise<number> {
  const id = `${uid}:${dayKey()}`;
  const snap = await firestore().collection('usage_daily').doc(id).get();
  return (snap.data()?.count as number | undefined) ?? 0;
}
