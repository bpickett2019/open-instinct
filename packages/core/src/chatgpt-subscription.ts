import fs from "node:fs";
import path from "node:path";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { StateDir } from "./state.js";

const PROVIDER = "openai-codex";
const AUTH_ERROR = "ChatGPT subscription authentication unavailable. Run instinct auth login for this data directory. No API-key fallback was used.";
export interface SubscriptionStatus {
  provider: "openai-codex";
  signedIn: boolean;
  expiresAt: string | null;
  refreshRequired: boolean;
}
export interface SubscriptionOptions {
  /** Test/provider seam; production uses Pi's existing Codex OAuth flow. */
  oauth?: OAuthAuth;
  onSecrets?: (values: string[]) => void;
  now?: () => number;
}

/** Operator-only authentication. Credentials never enter business records or exports. */
export class ChatGPTSubscription {
  private constructor(private readonly state: StateDir, private readonly directory: string, private readonly runtime: ModelRuntime, private readonly options: SubscriptionOptions) {}

  static async open(state: StateDir, options: SubscriptionOptions = {}): Promise<ChatGPTSubscription> {
    state.ensure();
    const directory = state.path("model-auth");
    ChatGPTSubscription.readCredential(state, directory, options.onSecrets);
    const authPath = path.join(directory, "auth.json");
    try { const fd = fs.openSync(authPath, "wx", 0o600); try { fs.writeFileSync(fd, "{}"); } finally { fs.closeSync(fd); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(AUTH_ERROR); }
    try {
      // Validate before Pi can resolve command-valued API credentials. Never load
      // user-global Pi config, Codex login, or a network model catalog.
      const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: path.join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
      if (options.oauth) runtime.registerNativeProvider({ ...openaiCodexProvider(), auth: { oauth: options.oauth } });
      const auth = new ChatGPTSubscription(state, directory, runtime, options);
      auth.credential();
      return auth;
    } catch { throw new Error(AUTH_ERROR); }
  }

  private static protect(state: StateDir, directory: string): void {
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Model authentication directory must be a private real directory");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const workspace = fs.realpathSync(state.path("workspace")), canonical = fs.realpathSync(directory);
    const contains = (root: string, target: string) => { const relative = path.relative(root, target); return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
    if (contains(workspace, canonical) || contains(canonical, workspace)) throw new Error("Model authentication must not overlap the worker workspace");
    fs.chmodSync(directory, 0o700);
    for (const name of ["auth.json", "models.json"]) {
      const file = path.join(directory, name), stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("Model authentication files must be private regular files, not links");
      if (stat) fs.chmodSync(file, 0o600);
    }
  }

  private credential(): OAuthCredential | undefined {
    return ChatGPTSubscription.readCredential(this.state, this.directory, this.options.onSecrets);
  }

  private static readCredential(state: StateDir, directory: string, onSecrets?: (values: string[]) => void): OAuthCredential | undefined {
    ChatGPTSubscription.protect(state, directory);
    const file = path.join(directory, "auth.json");
    if (!fs.existsSync(file)) return undefined;
    let data: Record<string, unknown>;
    try {
      if (fs.statSync(file).size > 1024 * 1024) throw new Error();
      data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => key !== PROVIDER)) throw new Error();
      const value = data[PROVIDER];
      if (value === undefined) return undefined;
      const credential = value as OAuthCredential;
      if (!credential || credential.type !== "oauth" || typeof credential.access !== "string" || !credential.access || typeof credential.refresh !== "string" || !credential.refresh || !Number.isFinite(credential.expires) || credential.expires <= 0 || credential.expires > 8.64e15) throw new Error();
      onSecrets?.([credential.access, credential.refresh]);
      return credential;
    } catch {
      // JSON/parser/provider exceptions may quote credential bytes. Never forward them.
      throw new Error(AUTH_ERROR);
    }
  }

  async status(): Promise<SubscriptionStatus> {
    const credential = this.credential();
    return { provider: PROVIDER, signedIn: Boolean(credential), expiresAt: credential ? new Date(credential.expires).toISOString() : null, refreshRequired: Boolean(credential && credential.expires <= (this.options.now?.() ?? Date.now()) + 300_000) };
  }

  models(): string[] { return this.runtime.getModels(PROVIDER).map(model => `${PROVIDER}/${model.id}`); }

  async login(interaction: AuthInteraction): Promise<void> {
    this.credential();
    try {
      await this.runtime.login(PROVIDER, "oauth", interaction);
      if (!this.credential()) throw new Error();
    } catch {
      throw new Error("ChatGPT sign-in did not complete. Retry instinct auth login; no API-key fallback was used.");
    }
  }

  async key(): Promise<string> {
    if (!this.credential()) throw new Error(AUTH_ERROR);
    try {
      // Pi serializes refresh under its cross-process credential-store lock.
      const result = await this.runtime.getAuth(PROVIDER, { signal: AbortSignal.timeout(30_000) });
      this.credential();
      const key = result?.auth.apiKey;
      if (!key) throw new Error();
      this.options.onSecrets?.([key]);
      return key;
    } catch { throw new Error(AUTH_ERROR); }
  }

  async logout(): Promise<void> {
    this.credential();
    try { await this.runtime.logout(PROVIDER, { signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error("Could not remove this workspace's ChatGPT sign-in. Stop the controller and check private model-auth storage."); }
  }
}
