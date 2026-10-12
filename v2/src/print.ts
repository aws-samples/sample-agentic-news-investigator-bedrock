// SPDX-License-Identifier: MIT-0
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Renders the letter's narrative to PDF and sends it to a printer.
 *
 * Only the narrative is printed, never the data appendix: the appendix is the
 * model's input, not the report, and what the user wants on paper is "the fable
 * generated portion".
 *
 * Chain: pandoc -> HTML -> weasyprint -> PDF -> lp.
 *
 * Two environment landmines, both handled here rather than in the service
 * manager's unit file so the job keeps working if that file is ever rewritten:
 *  - weasyprint dies with "cannot load library 'libgobject-2.0-0'" unless the
 *    dynamic loader can find glib/pango/cairo. On macOS that means
 *    DYLD_FALLBACK_LIBRARY_PATH must include the package manager's lib
 *    directory: V2_WEASYPRINT_LIB_DIR names it explicitly, and when Homebrew's
 *    shellenv has exported HOMEBREW_PREFIX that prefix's lib is used. The
 *    libraries were always installed; only the search path was ever missing.
 *  - weasyprint is usually a user-level pip install, whose bin directory is NOT
 *    on a service manager's minimal PATH, so it is resolved explicitly:
 *    V2_WEASYPRINT, then PATH, then the common per-user and system prefixes.
 *
 * Headless Chrome was the obvious alternative and is deliberately not used: it
 * writes a complete PDF and then never exits (it hands off to the user's running
 * Chrome), so an unattended run would hang forever.
 */

/** Directory holding weasyprint's native libraries, if the loader needs help. */
const NATIVE_LIB_DIR =
  process.env.V2_WEASYPRINT_LIB_DIR ??
  (process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, "lib") : undefined);

/** `~/Library/Python/<ver>/bin` for every Python a user-level pip has installed into. */
function userPythonBins(): string[] {
  const root = path.join(os.homedir(), "Library", "Python");
  try {
    return fs
      .readdirSync(root)
      .sort()
      .reverse()
      .map((v) => path.join(root, v, "bin", "weasyprint"));
  } catch {
    return [];
  }
}

const WEASYPRINT_CANDIDATES = [
  process.env.V2_WEASYPRINT,
  ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "weasyprint")),
  path.join(os.homedir(), ".local", "bin", "weasyprint"),
  ...userPythonBins(),
  process.env.HOMEBREW_PREFIX ? path.join(process.env.HOMEBREW_PREFIX, "bin", "weasyprint") : undefined,
  "/usr/local/bin/weasyprint",
  "/usr/bin/weasyprint",
].filter((p): p is string => !!p);

function weasyprintBin(): string {
  const found = WEASYPRINT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `weasyprint not found (looked in ${WEASYPRINT_CANDIDATES.join(", ")}); set V2_WEASYPRINT`,
    );
  }
  return found;
}

/** Print-only stylesheet: a letter meant to be read on paper, not a web page. */
const CSS = `<style>
  @page { size: Letter; margin: 1in 1.1in; }
  html { font-size: 11.5pt; }
  /* padding/max-width reset pandoc's own default template CSS (50px padding and
     a 36em measure), which would otherwise fight the @page margins. */
  body {
    font-family: Palatino, "Palatino Linotype", Georgia, serif;
    line-height: 1.5; color: #111;
    margin: 0; padding: 0; max-width: none;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.15rem; line-height: 1.25; }
  .subtitle { color: #555; font-style: italic; margin: 0 0 1.4rem; }
  h2, h3 { font-size: 1.05rem; margin: 1.6rem 0 0.4rem; page-break-after: avoid; }
  p { margin: 0 0 0.85rem; text-align: justify; hyphens: auto; orphans: 3; widows: 3; }
  strong { font-weight: 600; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 1.5rem 0; }
</style>`;

/**
 * Markdown narrative -> print-ready PDF at `outPdf`. `title` and `subtitle`
 * become the letterhead, so the narrative must not repeat them (the caller
 * strips the model's own title first).
 */
export function renderNarrativePdf(
  title: string,
  subtitle: string,
  narrativeMd: string,
  outPdf: string,
): void {
  const bin = weasyprintBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fin-letter-"));
  try {
    const md = path.join(dir, "letter.md");
    const header = path.join(dir, "header.html");
    const html = path.join(dir, "letter.html");
    // The subtitle rides in as raw HTML so it can be styled apart from the prose.
    fs.writeFileSync(
      md,
      `# ${title}\n\n<p class="subtitle">${subtitle}</p>\n\n${narrativeMd}\n`,
    );
    fs.writeFileSync(header, CSS);
    execFileSync("pandoc", [
      md,
      "-f", "markdown+raw_html",
      "-t", "html5",
      "--standalone",
      "--include-in-header", header,
      // pagetitle, not title: pandoc's HTML template renders `title` as an <h1>
      // in the body, which would duplicate the letterhead written above.
      "-V", `pagetitle=${title}`,
      "-o", html,
    ]);
    execFileSync(bin, [html, outPdf], {
      stdio: "ignore",
      env: {
        ...process.env,
        DYLD_FALLBACK_LIBRARY_PATH: [
          NATIVE_LIB_DIR,
          process.env.DYLD_FALLBACK_LIBRARY_PATH,
        ]
          .filter(Boolean)
          .join(":"),
      },
    });
    if (!fs.existsSync(outPdf)) throw new Error(`weasyprint produced no PDF at ${outPdf}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * How a PDF gets to paper on this host. Pure: decided from the platform and the
 * environment so it can be tested without spawning anything.
 *
 *  - `V2_PRINT_CMD` set: run that command with the PDF path as its only
 *    argument, on any platform. The portable escape hatch for hosts without
 *    CUPS at /usr/bin/lp (a Linux box with `lpr`, a script that mails the PDF).
 *  - otherwise on macOS: `/usr/bin/lp [-d printer] pdf`, the CUPS default queue
 *    when `printer` is unset. Unchanged from the original macOS-only behaviour.
 *  - otherwise: nothing to run; the caller logs and moves on.
 */
export type PrintPlan =
  | { kind: "cups"; bin: string; args: string[] }
  | { kind: "command"; bin: string; args: string[] }
  | { kind: "unavailable"; reason: string };

export function printPlan(
  pdf: string,
  printer: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PrintPlan {
  const custom = env.V2_PRINT_CMD?.trim();
  if (custom) return { kind: "command", bin: custom, args: [pdf] };
  if (platform === "darwin") {
    return { kind: "cups", bin: "/usr/bin/lp", args: printer ? ["-d", printer, pdf] : [pdf] };
  }
  return {
    kind: "unavailable",
    reason: `printing not available on this platform (${platform}); set V2_PRINT_CMD to a command that takes the PDF path`,
  };
}

/**
 * Sends the PDF to the printer per `printPlan`. Returns the print command's
 * reply (lp's "request id is ..." on macOS), or null when this host has no way
 * to print — logged, never thrown, so the letter run is never failed by paper.
 */
export function printPdf(pdf: string, printer?: string): string | null {
  const plan = printPlan(pdf, printer);
  if (plan.kind === "unavailable") {
    console.log(`[print] ${plan.reason}`);
    return null;
  }
  return execFileSync(plan.bin, plan.args, { encoding: "utf8" }).trim();
}
