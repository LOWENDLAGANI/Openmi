import type { Profile } from '../shared/types.js';
import { collections, firestore } from '../firebase.js';

export async function getOrCreateProfile(
  uid: string,
  info: { email?: string; displayName?: string; photoURL?: string },
): Promise<Profile> {
  const ref = collections.profiles().doc(uid);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data()!;
    return {
      uid,
      email: data.email,
      displayName: data.displayName,
      photoURL: data.photoURL,
      githubLinked: !!data.githubLinked,
      githubAppInstalled: !!data.githubAppInstalled,
      createdAt: data.createdAt?.toMillis?.() ?? Date.now(),
    };
  }
  const now = Date.now();
  const profile: Profile = {
    uid,
    email: info.email,
    displayName: info.displayName,
    photoURL: info.photoURL,
    githubLinked: false,
    githubAppInstalled: false,
    createdAt: now,
  };
  await ref.set({
    email: info.email,
    displayName: info.displayName,
    photoURL: info.photoURL,
    githubLinked: false,
    githubAppInstalled: false,
    createdAt: new Date(now),
  });
  return profile;
}

export async function setProfileFlag(uid: string, flag: 'githubLinked' | 'githubAppInstalled', value: boolean) {
  await collections.profiles().doc(uid).set({ [flag]: value }, { merge: true });
}
