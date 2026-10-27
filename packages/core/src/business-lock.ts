import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Reject symlink components, allowing macOS's canonical /tmp alias. */
export function privateBusinessPath(input: string): string {
  const path = resolve(input);
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("No existing storage ancestor");
    ancestor = parent;
  }
  if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Storage symlink rejected");
  const canonical = realpathSync(ancestor);
  if (canonical !== ancestor && canonical !== ancestor.replace(/^\/tmp(?=\/|$)/, "/private/tmp")) throw new Error("Storage parent symlink rejected");
  return path;
}

/**
 * A separate SQLite file is an OS-backed mutex, not business state. Its exclusive
 * transaction releases on process death. Never unlink this file: doing so would
 * let two processes lock different inodes. Keeping it beside the directory makes
 * restore's atomic directory replacement safe under the same ownership lock.
 */
export function acquireBusinessLock(directory: string): () => void {
  const root = privateBusinessPath(directory);
  const parent = dirname(root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const file = join(parent, `.${basename(root)}.controller-lock.sqlite`);
  const ownerFile = join(parent, `.${basename(root)}.controller-owner.json`);
  for (const path of [file, ownerFile]) if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("Unsafe controller lock file");
  const lock = new DatabaseSync(file);
  chmodSync(file, 0o600);
  let held = false;
  const token = randomUUID();
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    held = true;
    if (existsSync(ownerFile)) {
      const prior = JSON.parse(readFileSync(ownerFile, "utf8")) as { pid?: unknown };
      if (!Number.isSafeInteger(prior.pid) || Number(prior.pid) <= 0) throw new Error("Invalid controller ownership record; operator investigation required");
      try {
        process.kill(Number(prior.pid), 0);
        throw new Error("Business controller is still running");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    chmodSync(ownerFile, 0o600);
  } catch (error) {
    if (held) lock.exec("ROLLBACK");
    lock.close();
    throw new Error("Business state is owned by another controller or recovery operation", { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { token?: unknown };
      if (owner.token !== token) throw new Error("Controller ownership changed unexpectedly");
      unlinkSync(ownerFile);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  };
}
