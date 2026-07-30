/**
 * Port for the platform Auth System (khal M2M model). The module never
 * inspects tokens itself: it forwards the caller's bearer token and gets back
 * only authenticated-or-not — no scope checks, no tenant logic (those were
 * removed from the M2M model platform-side; the token already identifies an
 * authenticated tenant + client).
 */
export interface TokenAuthenticator {
  isAuthenticated(token: string): Promise<boolean>;
}
