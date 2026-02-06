#!/usr/bin/env bun

// Minimal interactive Gemini runner for tmux panes.
// - First turn comes from a prompt file (supports multi-line prompts).
// - Subsequent turns come from stdin (one message per line).
// - Type "/done" or "/exit" to end the session.

import { existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { spawnSync } from "child_process";
import { GoogleGenAI } from "@google/genai";

type Args = {
  model: string;
  promptFile: string;
  project: string | null;
  location: string | null;
};

function parseArgs(argv: string[]): Args {
  let model = "";
  let promptFile = "";
  let project: string | null = null;
  let location: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") model = argv[++i] ?? "";
    else if (arg === "--prompt-file") promptFile = argv[++i] ?? "";
    else if (arg === "--project") project = (argv[++i] ?? "").trim() || null;
    else if (arg === "--location") location = (argv[++i] ?? "").trim() || null;
  }

  if (!model) {
    console.error("Error: --model is required");
    process.exit(1);
  }

  if (!promptFile) {
    console.error("Error: --prompt-file is required");
    process.exit(1);
  }

  return { model, promptFile, project, location };
}

function tryGcloud(args: string[]): string | null {
  const res = spawnSync("gcloud", args, { stdio: "pipe", encoding: "utf-8" });
  if (res.status !== 0 || res.error) return null;
  const value = (res.stdout || "").trim();
  if (!value || value === "(unset)") return null;
  return value;
}

function detectProject(explicit: string | null): string | null {
  if (explicit) return explicit;
  const env = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (env && env.trim()) return env.trim();
  return tryGcloud(["config", "get-value", "project"]);
}

function detectLocation(explicit: string | null): string {
  if (explicit) return explicit;
  const env = process.env.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_CLOUD_REGION;
  if (env && env.trim()) return env.trim();
  // Vertex AI is regional. us-central1 is a sane default for most setups.
  return "us-central1";
}

function hasAdcCredentials(): boolean {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && existsSync(gac)) return true;

  const home = process.env.HOME;
  if (!home) return false;

  const candidates = [
    `${home}/.config/gcloud/application_default_credentials.json`,
    `${home}/Library/Application Support/gcloud/application_default_credentials.json`,
  ];
  return candidates.some((p) => existsSync(p));
}

function buildClient(project: string, location: string): GoogleGenAI {
  // OAuth/ADC only: use Vertex AI (no API keys).
  return new GoogleGenAI({ vertexai: true, project, location });
}

async function main() {
  const { model, promptFile, project: projectArg, location: locationArg } = parseArgs(
    process.argv.slice(2)
  );

  if (!hasAdcCredentials()) {
    console.error("Error: Google ADC (OAuth) not configured.");
    console.error("Run: gcloud auth application-default login");
    console.error("Then set a project (one of):");
    console.error("  - gcloud config set project <PROJECT_ID>");
    console.error("  - export GOOGLE_CLOUD_PROJECT=<PROJECT_ID>");
    process.exit(1);
  }

  const project = detectProject(projectArg);
  if (!project) {
    console.error("Error: Google Cloud project not detected.");
    console.error("Set it with: gcloud config set project <PROJECT_ID>");
    console.error("Or export GOOGLE_CLOUD_PROJECT=<PROJECT_ID>");
    process.exit(1);
  }

  const location = detectLocation(locationArg);
  const ai = buildClient(project, location);

  const initialPrompt = readFileSync(promptFile, "utf-8").trimEnd();

  console.log(`[gemini-agent] model=${model}`);
  console.log(`[gemini-agent] vertex_project=${project}`);
  console.log(`[gemini-agent] vertex_location=${location}`);
  console.log(`[gemini-agent] commands: /done, /exit`);
  console.log("");

  const chat = ai.chats.create({ model });

  const runTurn = async (message: string) => {
    const response = await chat.sendMessage({ message });
    const text = response?.text ?? "";
    if (text) {
      process.stdout.write(text);
      if (!text.endsWith("\n")) process.stdout.write("\n");
    }
  };

  await runTurn(initialPrompt);

  const rl = createInterface({ input: process.stdin, terminal: false });

  // Ensure sequential API calls even if multiple lines are pasted quickly.
  let queue = Promise.resolve();

  rl.on("line", (line) => {
    const input = line.trimEnd();
    if (!input) return;

    queue = queue
      .then(async () => {
        if (input === "/done" || input === "/exit" || input === "/quit") {
          rl.close();
          process.exit(0);
        }
        await runTurn(input);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
      });
  });

  process.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
