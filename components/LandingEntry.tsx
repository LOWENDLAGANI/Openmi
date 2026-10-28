"use client";

import { useState } from "react";
import OpenmiLanding from "./OpenmiLanding";
import AuthScreen from "./AuthScreen";

/** The public /landing route: the page, with sign-in opened in place so a
 *  visitor never has to leave the page they were reading to create an account. */
export default function LandingEntry() {
  const [signingIn, setSigningIn] = useState(false);

  if (signingIn) return <AuthScreen onBack={() => setSigningIn(false)} />;
  return <OpenmiLanding onSignIn={() => setSigningIn(true)} />;
}
