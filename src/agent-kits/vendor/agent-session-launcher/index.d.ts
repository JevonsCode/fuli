export interface SessionTarget {
  client: string;
  conversationId?: string;
  hostSessionId?: string;
  workspacePath?: string;
}

export interface LaunchPreferences {
  macosTerminal?: 'terminal' | 'iterm';
  itermOpenMode?: 'new-window' | 'new-tab';
}

export interface LaunchPlan {
  kind: 'cli' | 'uri';
  uri?: string;
  executable?: string;
  arguments?: string[];
  workspacePath?: string;
  /**
   * Windows CLI plans only: Windows Terminal when `wt.exe` is on PATH,
   * otherwise a new console window through Windows PowerShell.
   */
  opener?: 'windows-terminal' | 'powershell';
}

export interface ClientInfo {
  id: string;
  name: string;
  enabled: boolean;
  builtin: boolean;
  /** Where the client was first defined. */
  origin: 'builtin' | 'extension' | 'host';
  /** The user extension file that defines or customizes this client. */
  extensionFile?: string;
  /** null: identified, but no verified opening method. */
  kind: 'cli' | 'uri' | null;
  idSource?: 'conversationId' | 'hostSessionId';
  idFormat?: 'safe' | 'uuid' | 'claude-desktop' | 'cursor-background';
  requiresWorkspace: boolean;
  openSupported: boolean;
}

/** A skipped extension file; `file` is a file name, never a full path. */
export interface ExtensionProblem {
  file?: string;
  message: string;
}

/**
 * Every failure rejects (never throws synchronously) with an Error whose
 * `code` is a launcher error code from the protocol, or one of the binding's:
 * - `invalid_executable`, `invalid_timeout`, `invalid_configuration`,
 *   `invalid_request`: the call was refused before anything started;
 * - `unavailable`: the executable could not start;
 * - `invalid_response`: the output was not one bounded version-1 JSON object;
 * - `unknown_outcome`: no answer within `timeoutMs`; the process was killed
 *   and the action may already have happened. Never retry automatically,
 *   especially `open`: the session may already be open.
 */
export interface LauncherError extends Error {
  code: string;
}

export interface LauncherOptions {
  /** Absolute path to the native executable for this OS and CPU. */
  executable: string;
  /** Absolute path to a trusted host configuration file. */
  configPath?: string;
  /** Absolute path to the user's extension directory, usually `defaultExtensionsDirectory()`. */
  extensionsDir?: string;
  /** Milliseconds to wait for each call: default 8000, at most 60000. */
  timeoutMs?: number;
}

export interface Launcher {
  classify(source: string, options?: { claudeEntrypoint?: string }): Promise<string>;
  clients(): Promise<{ clients: ClientInfo[]; extensionErrors: ExtensionProblem[] }>;
  inspect(target: SessionTarget): Promise<{ plan: LaunchPlan; openSupported: boolean }>;
  /** Only for an explicit user action; never retry automatically on `unknown_outcome`. */
  open(target: SessionTarget, preferences?: LaunchPreferences): Promise<'launch_requested'>;
}

export function createLauncher(options: LauncherOptions): Launcher;

/**
 * The shared per-user extension directory (`agent-clients/extensions` under
 * `%APPDATA%`, `$XDG_CONFIG_HOME` or `~/.config`), or the 0.3 directory
 * `agent-session-launcher/clients` while the new one does not exist;
 * undefined without a home directory.
 */
export function defaultExtensionsDirectory(
  env?: Record<string, string | undefined>,
  platform?: string,
): string | undefined;

/** One raw request; resolves `ok: false` responses instead of rejecting them. */
export function requestLauncher(
  executable: string,
  request: Record<string, unknown>,
  options?: { timeoutMs?: number; configPath?: string; extensionsDir?: string },
): Promise<Record<string, unknown> & { version: 1; ok: boolean }>;
