export type Component = 'mcp' | 'hooks' | 'permissions' | 'instructions' | 'skills' | 'plugin';

export interface ExtensionProblem {
  file?: string;
  message: string;
}

export interface TargetScan {
  id: string;
  name: string;
  detected: boolean;
  /** What showed the client is installed, e.g. `~/.codex/config.toml` or `command: codex`. */
  evidence: string[];
  components: Component[];
  builtin: boolean;
  platformSupported: boolean;
  /** Why the client must be configured by hand. */
  manual?: string;
  extensionFile?: string;
}

export interface ComponentStatus {
  component: Component;
  state: 'current' | 'outdated' | 'missing' | 'conflict' | 'unsupported';
  message?: string;
  /** Where the component lives in this client, relative to home, e.g. `~/.acme/mcp.json`. */
  paths?: string[];
}

export type ClientState =
  | 'connected' | 'update_available' | 'not_connected' | 'conflict' | 'manual' | 'unsupported';

export interface ClientStatus extends TargetScan {
  state: ClientState;
  componentStates: ComponentStatus[];
}

export interface PlannedChange {
  /** Shown relative to the home directory, e.g. `~/.claude.json`. */
  path: string;
  components: Component[];
  /** `adopt`: an existing directory that already holds the product's files gets its receipt. */
  action: 'create' | 'update' | 'delete' | 'adopt';
  diff?: string;
  /** How the change was made when that differs, e.g. a directory in use updated in place. */
  note?: string;
}

export interface ClientResult {
  id: string;
  name: string;
  state: ClientState;
  changes: PlannedChange[];
  /** Components that could not be changed, with the reason. */
  problems: string[];
  /** What the person still has to do, e.g. restart the client, in English. */
  actions: string[];
  /** One stable code per entry of `actions`, in the same order, for the host's own wording. */
  actionCodes: ActionCode[];
}

/** See docs/result.schema.json. */
export type ActionCode = 'restart_client' | 'new_session' | 'reload_config' | 'trust_hooks' | 'other';

export interface InstallerOptions {
  /** Absolute path to the native `agent-installer` for this OS and CPU. */
  executable: string;
  /** Absolute path to the product manifest. */
  manifestPath: string;
  /** Values for the manifest's `{placeholders}`. */
  variables?: Record<string, string>;
  /** Defaults to the shared per-user extension directory, `defaultExtensionsDirectory()`. */
  extensionsDir?: string;
  /** Where originals are copied before a change; defaults to `defaultBackupsDirectory(product)`. */
  backupsDir?: string;
  /**
   * How long one call may take, 1 to 600000 ms; default 60000. When it runs
   * out the process is killed and the call rejects with `unknown_outcome`.
   */
  timeoutMs?: number;
}

/**
 * Every failure rejects (never throws synchronously) with an Error whose
 * `code` is an installer code (`invalid_manifest`, `unknown_client`, …) or a
 * binding code: `invalid_arguments`, `invalid_timeout`, `unavailable` (the
 * executable could not start), `invalid_response`, or `unknown_outcome`
 * (no answer in time: files may or may not have changed, so never retry
 * `apply` or `remove` automatically; call `status` first).
 */
export interface InstallerError extends Error {
  code: string;
}

/** What `plan`, `apply` and `remove` resolve with. */
export interface ClientResults {
  clients: ClientResult[];
  /**
   * True when the run finished but some components were left alone (the
   * executable exited with 2); `problems` says which and why.
   */
  partial: boolean;
  /** Every client's `problems`, flattened. */
  problems: { client: string; message: string }[];
  extensionErrors: ExtensionProblem[];
}

export interface Installer {
  scan(): Promise<{ clients: TargetScan[]; extensionErrors: ExtensionProblem[] }>;
  status(clients?: string[]): Promise<{ clients: ClientStatus[]; extensionErrors: ExtensionProblem[] }>;
  /** A dry run: returns the changes and diffs without writing. */
  plan(clients: string[]): Promise<ClientResults>;
  /** Writes; call only for clients the person selected. A partial run resolves with `partial: true`. */
  apply(clients: string[]): Promise<ClientResults>;
  remove(clients: string[]): Promise<ClientResults>;
}

export function createInstaller(options: InstallerOptions): Installer;

/** The shared per-user extension directory, or undefined without a home directory. */
export function defaultExtensionsDirectory(
  env?: Record<string, string | undefined>,
  platform?: string,
): string | undefined;

/** `agent-clients/backups/<product>` in the shared root, or undefined without a home directory. */
export function defaultBackupsDirectory(
  product: string,
  env?: Record<string, string | undefined>,
  platform?: string,
): string | undefined;
