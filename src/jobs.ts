// Job management for async codex agent execution with tmux

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { config, Provider, ReasoningEffort, SandboxMode } from "./config.ts";
import { randomBytes } from "crypto";
import { extractSessionId, findSessionFile, parseSessionFile, type ParsedSessionData } from "./session-parser.ts";
import {
  createSession,
  killSession,
  sessionExists,
  getSessionName,
  capturePane,
  captureFullHistory,
  isSessionActive,
  sendMessage,
  sendControl,
} from "./tmux.ts";

export interface Job {
  id: string;
  provider: Provider;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  parentSessionId?: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  tmuxSession?: string;
  result?: string;
  error?: string;
}

function ensureJobsDir(): void {
  mkdirSync(config.jobsDir, { recursive: true });
}

function generateJobId(): string {
  return randomBytes(4).toString("hex");
}

function getJobPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.json`);
}

function normalizeProvider(value: unknown): Provider {
  return value === "gemini" ? "gemini" : "codex";
}

function normalizeJob(raw: any): Job {
  // Backwards compatible with older job files that didn't include `provider`.
  return {
    ...raw,
    provider: normalizeProvider(raw?.provider),
  } as Job;
}

export function saveJob(job: Job): void {
  ensureJobsDir();
  writeFileSync(getJobPath(job.id), JSON.stringify(job, null, 2));
}

export function loadJob(jobId: string): Job | null {
  try {
    const content = readFileSync(getJobPath(jobId), "utf-8");
    return normalizeJob(JSON.parse(content));
  } catch {
    return null;
  }
}

export function listJobs(): Job[] {
  ensureJobsDir();
  const files = readdirSync(config.jobsDir).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        const content = readFileSync(join(config.jobsDir, f), "utf-8");
        return normalizeJob(JSON.parse(content));
      } catch {
        return null;
      }
    })
    .filter((j): j is Job => j !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function computeElapsedMs(job: Job): number {
  const start = job.startedAt ?? job.createdAt;
  const startMs = Date.parse(start);
  const endMs = job.completedAt ? Date.parse(job.completedAt) : Date.now();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function getLogMtimeMs(jobId: string): number | null {
  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    return statSync(logFile).mtimeMs;
  } catch {
    return null;
  }
}

function getLastActivityMs(job: Job): number | null {
  const logMtime = getLogMtimeMs(job.id);
  if (logMtime !== null) return logMtime;

  const fallback = job.startedAt ?? job.createdAt;
  const fallbackMs = Date.parse(fallback);
  if (!Number.isFinite(fallbackMs)) return null;
  return fallbackMs;
}

function isInactiveTimedOut(job: Job): boolean {
  const timeoutMinutes = config.defaultTimeout;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return false;

  const lastActivityMs = getLastActivityMs(job);
  if (!lastActivityMs) return false;

  return Date.now() - lastActivityMs > timeoutMinutes * 60 * 1000;
}

function loadSessionData(jobId: string): ParsedSessionData | null {
  const logFile = join(config.jobsDir, `${jobId}.log`);
  let logContent: string;

  try {
    logContent = readFileSync(logFile, "utf-8");
  } catch {
    return null;
  }

  const sessionId = extractSessionId(logContent);
  if (!sessionId) return null;

  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) return null;

  return parseSessionFile(sessionFile);
}

export type JobsJsonEntry = {
  id: string;
  provider: Provider;
  status: Job["status"];
  prompt: string;
  model: string;
  reasoning: ReasoningEffort;
  cwd: string;
  elapsed_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tokens: ParsedSessionData["tokens"] | null;
  files_modified: ParsedSessionData["files_modified"] | null;
  summary: string | null;
};

export type JobsJsonOutput = {
  generated_at: string;
  jobs: JobsJsonEntry[];
};

export function getJobsJson(): JobsJsonOutput {
  const jobs = listJobs();
  const enriched = jobs.map((job) => {
    const refreshed = job.status === "running" ? refreshJobStatus(job.id) : null;
    const effective = refreshed ?? job;
    const elapsedMs = computeElapsedMs(effective);

    let tokens: ParsedSessionData["tokens"] | null = null;
    let filesModified: ParsedSessionData["files_modified"] | null = null;
    let summary: string | null = null;

    if (effective.status === "completed") {
      const sessionData = loadSessionData(effective.id);
      if (sessionData) {
        tokens = sessionData.tokens;
        filesModified = sessionData.files_modified;
        summary = sessionData.summary ? truncateText(sessionData.summary, 500) : null;
      }
    }

    return {
      id: effective.id,
      provider: effective.provider,
      status: effective.status,
      prompt: truncateText(effective.prompt, 100),
      model: effective.model,
      reasoning: effective.reasoningEffort,
      cwd: effective.cwd,
      elapsed_ms: elapsedMs,
      created_at: effective.createdAt,
      started_at: effective.startedAt ?? null,
      completed_at: effective.completedAt ?? null,
      tokens,
      files_modified: filesModified,
      summary,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    jobs: enriched,
  };
}

export function deleteJob(jobId: string): boolean {
  const job = loadJob(jobId);

  // Kill tmux session if running
  if (job?.tmuxSession && sessionExists(job.tmuxSession)) {
    killSession(job.tmuxSession);
  }

  try {
    unlinkSync(getJobPath(jobId));

    // Clean up prompt file if exists
    try {
      unlinkSync(join(config.jobsDir, `${jobId}.prompt`));
    } catch {
      // Prompt file may not exist
    }

    // Clean up log file if exists
    try {
      unlinkSync(join(config.jobsDir, `${jobId}.log`));
    } catch {
      // Log file may not exist
    }

    return true;
  } catch {
    return false;
  }
}

export interface StartJobOptions {
  prompt: string;
  provider?: Provider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  parentSessionId?: string;
  cwd?: string;
}

export function startJob(options: StartJobOptions): Job {
  ensureJobsDir();

  const jobId = generateJobId();
  const cwd = options.cwd || process.cwd();

  const provider = options.provider ?? config.defaultProvider;

  const job: Job = {
    id: jobId,
    provider,
    status: "pending",
    prompt: options.prompt,
    model: options.model || (provider === "gemini" ? config.geminiModel : config.codexModel),
    reasoningEffort: options.reasoningEffort || config.defaultReasoningEffort,
    sandbox: options.sandbox || config.defaultSandbox,
    parentSessionId: options.parentSessionId,
    cwd,
    createdAt: new Date().toISOString(),
  };

  saveJob(job);

  // Create tmux session with the selected provider
  const result = createSession({
    jobId,
    provider: job.provider,
    prompt: options.prompt,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    sandbox: job.sandbox,
    cwd,
  });

  if (result.success) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.tmuxSession = result.sessionName;
  } else {
    job.status = "failed";
    job.error = result.error || "Failed to create tmux session";
    job.completedAt = new Date().toISOString();
  }

  saveJob(job);
  return job;
}

export function killJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;

  // Kill tmux session
  if (job.tmuxSession) {
    killSession(job.tmuxSession);
  }

  job.status = "failed";
  job.error = "Killed by user";
  job.completedAt = new Date().toISOString();
  saveJob(job);
  return true;
}

export function sendToJob(jobId: string, message: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return sendMessage(job.tmuxSession, message);
}

export function sendControlToJob(jobId: string, key: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return sendControl(job.tmuxSession, key);
}

export function getJobOutput(jobId: string, lines?: number): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  // First try tmux capture if session exists
  if (job.tmuxSession && sessionExists(job.tmuxSession)) {
    const output = capturePane(job.tmuxSession, { lines });
    if (output) return output;
  }

  // Fall back to log file
  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    const content = readFileSync(logFile, "utf-8");
    if (lines) {
      const allLines = content.split("\n");
      return allLines.slice(-lines).join("\n");
    }
    return content;
  } catch {
    return null;
  }
}

export function getJobFullOutput(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  // First try tmux capture if session exists
  if (job.tmuxSession && sessionExists(job.tmuxSession)) {
    const output = captureFullHistory(job.tmuxSession);
    if (output) return output;
  }

  // Fall back to log file
  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    return readFileSync(logFile, "utf-8");
  } catch {
    return null;
  }
}

export function cleanupOldJobs(maxAgeDays: number = 7): number {
  const jobs = listJobs();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const job of jobs) {
    const jobTime = new Date(job.completedAt || job.createdAt).getTime();
    if (jobTime < cutoff && (job.status === "completed" || job.status === "failed")) {
      if (deleteJob(job.id)) cleaned++;
    }
  }

  return cleaned;
}

export function isJobRunning(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return isSessionActive(job.tmuxSession);
}

export function refreshJobStatus(jobId: string): Job | null {
  const job = loadJob(jobId);
  if (!job) return null;

  if (job.status === "running" && job.tmuxSession) {
    // Check if tmux session still exists
    if (!sessionExists(job.tmuxSession)) {
      // Session ended completely
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      const logFile = join(config.jobsDir, `${jobId}.log`);
      try {
        job.result = readFileSync(logFile, "utf-8");
      } catch {
        // No log file
      }
      saveJob(job);
    } else {
      // Session exists - check if codex is still running
      // Look for the "[codex-agent: Session complete" marker in output
      const output = capturePane(job.tmuxSession, { lines: 20 });
      if (output && output.includes("[codex-agent: Session complete")) {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        // Capture full output
        const fullOutput = captureFullHistory(job.tmuxSession);
        if (fullOutput) {
          job.result = fullOutput;
        }
        saveJob(job);
      } else if (isInactiveTimedOut(job)) {
        killSession(job.tmuxSession);
        job.status = "failed";
        job.error = `Timed out after ${config.defaultTimeout} minutes of inactivity`;
        job.completedAt = new Date().toISOString();
        saveJob(job);
      }
    }
  }

  return loadJob(jobId);
}

export function getAttachCommand(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return null;

  return `tmux attach -t "${job.tmuxSession}"`;
}
