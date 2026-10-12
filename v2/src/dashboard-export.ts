// SPDX-License-Identifier: MIT-0
/**
 * Export the dashboard as one self-contained HTML file you can send.
 *
 *   node dist/dashboard-export.js [--out <file>] [--url <base>] [--fresh] [--open]
 *
 * Reads `/api/overview` from the running dashboard server (`npm run dashboard`),
 * inlines `dashboard/{index.html,styles.css,app.js}` around it and writes
 * `reports/fin-dashboard-<local stamp>.html`. `--fresh` asks the server to
 * re-read first; `--open` opens the file. This process never touches AWS.
 * Entry point: importing it runs it — tests use `dashboard-static.ts` instead.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildStaticDashboard, snapshotFileName } from "./dashboard-static.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(HERE, "..", "dashboard");
const REPORTS_DIR = path.resolve(HERE, "..", "reports");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string): boolean => process.argv.includes(flag);

interface OverviewResponse {
  ok: boolean;
  overview?: { generatedAt: string };
  lastError?: string | null;
  warming?: boolean;
}

async function fetchOverview(base: string, fresh: boolean): Promise<{ generatedAt: string }> {
  if (fresh) await fetch(`${base}/api/refresh`);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const r = await fetch(`${base}/api/overview`, { cache: "no-store" });
    const j = (await r.json()) as OverviewResponse;
    if (j.ok && j.overview) return j.overview;
    if (Date.now() > deadline) throw new Error(`dashboard still warming up${j.lastError ? `: ${j.lastError}` : ""}`);
    process.stderr.write("[export] dashboard warming up, waiting…\n");
    await new Promise((res) => setTimeout(res, 3000));
  }
}

async function main(): Promise<void> {
  const base = (
    arg("--url") ?? process.env.V2_DASHBOARD_URL ?? `http://127.0.0.1:${process.env.V2_DASHBOARD_PORT ?? 4310}`
  ).replace(/\/$/, "");
  let overview: { generatedAt: string };
  try {
    overview = await fetchOverview(base, has("--fresh"));
  } catch (e) {
    const code = (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "ECONNREFUSED") {
      throw new Error(`no dashboard at ${base} — start it with \`npm run dashboard\` (or pass --url)`);
    }
    throw e;
  }
  const read = (f: string) => fs.readFileSync(path.join(STATIC_DIR, f), "utf8");
  const page = buildStaticDashboard({
    html: read("index.html"),
    css: read("styles.css"),
    js: read("app.js"),
    overview,
    exportedAtIso: new Date().toISOString(),
  });
  const out = path.resolve(arg("--out") ?? path.join(REPORTS_DIR, snapshotFileName(overview.generatedAt)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
  console.log(`${out}  (${Math.round(page.length / 1024)} KB, data as of ${overview.generatedAt})`);
  if (has("--open")) execFile(process.platform === "darwin" ? "open" : "xdg-open", [out]);
}

main().catch((e: unknown) => {
  console.error(`[export] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
