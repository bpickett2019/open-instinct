/**
 * Loader for @open-instinct/payments (Stripe Link agent wallet). The package is
 * optional at runtime: when it is not installed, or the three env vars are missing,
 * the agent boots without payment tools. The contract below mirrors the package's
 * exports so this file typechecks on its own.
 */
import type { AuditLog, CredentialVault, InstinctConfig, Outbox, RegisteredTool, StateDir } from "@open-instinct/core";

export interface LinkWalletLike {
  authorizeUrl(): { url: string; state: string };
  handleCallback(code: string, state: string): Promise<void>;
  isConnected(): boolean;
  revoke(): Promise<void>;
}

export interface LinkWalletOptions {
  state: StateDir;
  clientId: string;
  clientSecret: string;
  publishableKey: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface PaymentsToolDeps {
  wallet: LinkWalletLike;
  outbox: Outbox;
  config: InstinctConfig;
  audit: AuditLog;
  state: StateDir;
  credentialVault?: CredentialVault;
  workspaceId?: string;
}

export interface PaymentsModule {
  LinkWallet: new (opts: LinkWalletOptions) => LinkWalletLike;
  paymentsTools(deps: PaymentsToolDeps): RegisteredTool[];
}

export const PAYMENTS_PACKAGE = "@open-instinct/payments";
export const LINK_CALLBACK_PATH = "/oauth/link/callback";

export interface PaymentsEnv {
  clientId: string;
  clientSecret: string;
  publishableKey: string;
  redirectUri: string;
}

/**
 * Payments are on when all three Link/Stripe variables are set. The redirect URI is
 * LINK_REDIRECT_URI, else INSTINCT_PUBLIC_URL + the callback path, else loopback on
 * the local port (fine for `instinct dev`; the gateway relays the callback otherwise).
 */
export function paymentsEnv(env: NodeJS.ProcessEnv): PaymentsEnv | undefined {
  const clientId = env.LINK_CLIENT_ID?.trim();
  const clientSecret = env.LINK_CLIENT_SECRET?.trim();
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY?.trim();
  if (!clientId || !clientSecret || !publishableKey) return undefined;
  const explicit = env.LINK_REDIRECT_URI?.trim();
  const publicUrl = env.INSTINCT_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const port = env.PORT?.trim() || "8080";
  const redirectUri = explicit || (publicUrl ? `${publicUrl}${LINK_CALLBACK_PATH}` : `http://127.0.0.1:${port}${LINK_CALLBACK_PATH}`);
  return { clientId, clientSecret, publishableKey, redirectUri };
}

/** Import the payments package if it is installed. Undefined (never a throw) when it is not. */
export async function loadPaymentsModule(importer: (spec: string) => Promise<unknown> = (s) => import(s)): Promise<PaymentsModule | undefined> {
  try {
    const mod = (await importer(PAYMENTS_PACKAGE)) as Partial<PaymentsModule> | undefined;
    if (!mod || typeof mod.LinkWallet !== "function" || typeof mod.paymentsTools !== "function") return undefined;
    return mod as PaymentsModule;
  } catch {
    return undefined;
  }
}
