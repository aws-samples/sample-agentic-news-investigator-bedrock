// SPDX-License-Identifier: MIT-0
/**
 * Pure helpers that turn the live dashboard — its three static files plus one
 * `/api/overview` payload — into a single self-contained HTML file that can be
 * attached to an email and opened from disk. Nothing here reads AWS or the
 * filesystem: `dashboard.ts` (the `/snapshot.html` route) and
 * `dashboard-export.ts` (the CLI) feed it.
 *
 * The page's own script (`dashboard/app.js`) looks for `window.__FIN_SNAPSHOT__`
 * and, when present, renders it once and disables polling, refresh, download
 * and the letter links (which point at the loopback server).
 */

export interface StaticDashboardInputs {
  /** `dashboard/index.html` as served live. */
  html: string;
  /** `dashboard/styles.css`. */
  css: string;
  /** `dashboard/app.js`. */
  js: string;
  /** The `overview` object from `/api/overview`. */
  overview: unknown;
  /** When the export was taken (ISO). */
  exportedAtIso: string;
}

const STYLESHEET_TAG = '<link rel="stylesheet" href="/styles.css">';
const SCRIPT_TAG = '<script type="module" src="/app.js"></script>';

/** JSON that is safe inside a `<script>` block: `<` becomes `<`, so neither `</script>` nor `<!--` can occur. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Local YYYY-MM-DD and HHMM for a timestamp. */
function localStamp(iso: string): { day: string; hm: string } {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hm: `${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

/** `fin-dashboard-YYYY-MM-DD-HHMM.html`, local time of the data it carries. */
export function snapshotFileName(generatedAtIso: string): string {
  const { day, hm } = localStamp(generatedAtIso);
  return `fin-dashboard-${day}-${hm}.html`;
}

export function buildStaticDashboard(i: StaticDashboardInputs): string {
  if (!i.html.includes(STYLESHEET_TAG)) throw new Error(`index.html: stylesheet tag not found (${STYLESHEET_TAG})`);
  if (!i.html.includes(SCRIPT_TAG)) throw new Error(`index.html: script tag not found (${SCRIPT_TAG})`);
  if (/<\/script/i.test(i.js)) throw new Error("app.js contains '</script' and cannot be inlined");
  if (/<\/style/i.test(i.css)) throw new Error("styles.css contains '</style' and cannot be inlined");
  const generatedAt =
    typeof i.overview === "object" && i.overview !== null && typeof (i.overview as { generatedAt?: unknown }).generatedAt === "string"
      ? (i.overview as { generatedAt: string }).generatedAt
      : i.exportedAtIso;
  const { day } = localStamp(generatedAt);
  const snapshot = embedJson({ overview: i.overview, exportedAt: i.exportedAtIso });
  // Replacer functions: the CSS and JS contain `$`, which a replacement *string* would interpret.
  return i.html
    .replace(STYLESHEET_TAG, () => `<style>\n${i.css}\n</style>`)
    .replace(SCRIPT_TAG, () => `<script>window.__FIN_SNAPSHOT__ = ${snapshot};</script>\n<script type="module">\n${i.js}\n</script>`)
    .replace(/<title>([^<]*)<\/title>/, (_m, t: string) => `<title>${t} · snapshot ${day}</title>`);
}
