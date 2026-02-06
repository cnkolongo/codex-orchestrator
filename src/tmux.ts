// tmux helper functions for codex-agent

import { execFileSync, spawnSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { config, Provider } from "./config.ts";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: string;
}

function shQuote(value: string): string {
  // Safe for POSIX shells: wrap in single quotes and escape internal single quotes.
  // Example: foo'bar -> 'foo'"'"'bar'
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function tmuxOk(res: ReturnType<typeof spawnSync>): boolean {
  return res.status === 0 && !res.error;
}

function tmuxSpawn(args: string[], options: { cwd?: string } = {}): ReturnType<typeof spawnSync> {
  return spawnSync("tmux", args, {
    stdio: "pipe",
    encoding: "utf-8",
    ...options,
  });
}

function tmuxOut(args: string[], options: { cwd?: string; maxBuffer?: number } = {}): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    maxBuffer: options.maxBuffer,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Get tmux session name for a job
 */
export function getSessionName(jobId: string): string {
  return `${config.tmuxPrefix}-${jobId}`;
}

/**
 * Check if tmux is available
 */
export function isTmuxAvailable(): boolean {
  const res = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return tmuxOk(res);
}

/**
 * Check if a tmux session exists
 */
export function sessionExists(sessionName: string): boolean {
  const res = tmuxSpawn(["has-session", "-t", sessionName]);
  return tmuxOk(res);
}

/**
 * Create a new tmux session running codex (interactive mode)
 */
export function createSession(options: {
  jobId: string;
  provider: Provider;
  prompt: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  cwd: string;
}): { sessionName: string; success: boolean; error?: string } {
  const sessionName = getSessionName(options.jobId);
  const logFile = `${config.jobsDir}/${options.jobId}.log`;

  // Create prompt file to avoid shell escaping issues
  const promptFile = `${config.jobsDir}/${options.jobId}.prompt`;
  writeFileSync(promptFile, options.prompt);

  try {
    const isGemini = options.provider === "gemini";

    const srcDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(srcDir, "..");
    const geminiRunnerTs = resolve(repoRoot, "src/gemini-runner.ts");
    const geminiRunnerJs = resolve(repoRoot, "dist/gemini-runner.js");
    const geminiRunner = existsSync(geminiRunnerJs) ? geminiRunnerJs : geminiRunnerTs;

    let commandParts: string[];
    if (isGemini) {
      commandParts = [
        "script",
        "-q",
        logFile,
        "bun",
        geminiRunner,
        "--model",
        options.model,
        "--prompt-file",
        promptFile,
      ];
    } else {
      commandParts = [
        "script",
        "-q",
        logFile,
        "codex",
        "-c",
        `model=${options.model}`,
        "-c",
        `model_reasoning_effort=${options.reasoningEffort}`,
        "-c",
        "skip_update_check=true",
        "-a",
        "never",
        "-s",
        options.sandbox,
      ];
    }

    const shellCmd = `${commandParts.map(shQuote).join(" ")}; echo "\\n\\n[codex-agent: Session complete. Press Enter to close.]"; read`;

    const newRes = tmuxSpawn(["new-session", "-d", "-s", sessionName, "-c", options.cwd, shellCmd], {
      cwd: options.cwd,
    });
    if (!tmuxOk(newRes)) {
      const err = String(newRes.stderr || newRes.stdout || newRes.error?.message || "").trim();
      throw new Error(err || "Failed to create tmux session");
    }

    if (!isGemini) {
      // Give codex a moment to initialize and show update prompt if any
      spawnSync("sleep", ["1"]);

      // Skip update prompt if it appears by sending "3" (skip until next version)
      // Then Enter to dismiss any remaining prompts
      tmuxSpawn(["send-keys", "-t", sessionName, "3"]);
      spawnSync("sleep", ["0.5"]);
      tmuxSpawn(["send-keys", "-t", sessionName, "Enter"]);
      spawnSync("sleep", ["1"]);

      // Send the prompt to the codex TUI.
      const needsBuffer = options.prompt.length >= 5000 || options.prompt.includes("\n");
      if (needsBuffer) {
        tmuxSpawn(["load-buffer", promptFile]);
        tmuxSpawn(["paste-buffer", "-t", sessionName]);
      } else {
        tmuxSpawn(["send-keys", "-t", sessionName, options.prompt]);
      }
      spawnSync("sleep", ["0.3"]);
      tmuxSpawn(["send-keys", "-t", sessionName, "Enter"]);
    }

    return { sessionName, success: true };
  } catch (err) {
    return {
      sessionName,
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Send a message to a running codex session
 */
export function sendMessage(sessionName: string, message: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    tmuxSpawn(["send-keys", "-t", sessionName, message]);
    // Small delay before Enter for TUI to process
    spawnSync("sleep", ["0.3"]);
    tmuxSpawn(["send-keys", "-t", sessionName, "Enter"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a control key to a session (like Ctrl+C)
 */
export function sendControl(sessionName: string, key: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    const res = tmuxSpawn(["send-keys", "-t", sessionName, key]);
    return tmuxOk(res);
  } catch {
    return false;
  }
}

/**
 * Capture the current pane content
 */
export function capturePane(
  sessionName: string,
  options: { lines?: number; start?: number } = {}
): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  try {
    const args = ["capture-pane", "-t", sessionName, "-p"];

    if (options.start !== undefined) {
      args.push("-S", String(options.start));
    }

    const output = tmuxOut(args);

    if (options.lines) {
      const allLines = output.split("\n");
      return allLines.slice(-options.lines).join("\n");
    }

    return output;
  } catch {
    return null;
  }
}

/**
 * Get the full scrollback buffer
 */
export function captureFullHistory(sessionName: string): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  try {
    // Capture from start of history (-S -) to end
    const output = tmuxOut(["capture-pane", "-t", sessionName, "-p", "-S", "-"], {
      maxBuffer: 50 * 1024 * 1024,
    });
    return output;
  } catch {
    return null;
  }
}

/**
 * Kill a tmux session
 */
export function killSession(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    const res = tmuxSpawn(["kill-session", "-t", sessionName]);
    return tmuxOk(res);
  } catch {
    return false;
  }
}

/**
 * List all codex-agent sessions
 */
export function listSessions(): TmuxSession[] {
  try {
    const output = tmuxOut([
      "list-sessions",
      "-F",
      "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}",
    ]);

    return output
      .trim()
      .split("\n")
      .filter((line) => line.startsWith(config.tmuxPrefix))
      .map((line) => {
        const [name, attached, windows, created] = line.split("|");
        return {
          name,
          attached: attached === "1",
          windows: parseInt(windows, 10),
          created: new Date(parseInt(created, 10) * 1000).toISOString(),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Get the command to attach to a session (for display to user)
 */
export function getAttachCommand(sessionName: string): string {
  return `tmux attach -t "${sessionName}"`;
}

/**
 * Check if the session's codex process is still running
 */
export function isSessionActive(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    // Check if the pane has a running process
    const pid = tmuxOut(["list-panes", "-t", sessionName, "-F", "#{pane_pid}"]).trim();

    if (!pid) return false;

    // Check if that process is still running
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watch a session's output (returns a stream of updates)
 * This is for programmatic watching - for interactive use, just attach
 */
export function watchSession(
  sessionName: string,
  callback: (content: string) => void,
  intervalMs: number = 1000
): { stop: () => void } {
  let lastContent = "";
  let running = true;

  const interval = setInterval(() => {
    if (!running) return;

    const content = capturePane(sessionName, { lines: 100 });
    if (content && content !== lastContent) {
      // Only send the new lines
      const newContent = content.replace(lastContent, "").trim();
      if (newContent) {
        callback(newContent);
      }
      lastContent = content;
    }

    // Check if session still exists
    if (!sessionExists(sessionName)) {
      running = false;
      clearInterval(interval);
    }
  }, intervalMs);

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
    },
  };
}
