// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticDashboard, embedJson, snapshotFileName } from "../src/dashboard-static.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(HERE, "..", "dashboard");
const read = (f: string) => fs.readFileSync(path.join(STATIC_DIR, f), "utf8");

const HTML = [
  "<!doctype html><html><head><title>fin · paper-trading dashboard</title>",
  '<link rel="stylesheet" href="/styles.css">',
  '</head><body><script type="module" src="/app.js"></script></body></html>',
].join("\n");

describe("embedJson", () => {
  it("cannot close the script block from inside a string", () => {
    const headline = "</script><script>alert(1)</script> <!-- x";
    const s = embedJson({ headline });
    expect(s).not.toContain("</script");
    expect(s).not.toContain("<!--");
    expect(JSON.parse(s).headline).toBe(headline);
  });
});

describe("buildStaticDashboard", () => {
  const overview = { generatedAt: "2026-09-16T16:31:26.652Z", arms: {} };

  it("inlines the stylesheet and script and embeds the snapshot", () => {
    const js = "console.log($('x'), `$&`, `$1`)";
    const out = buildStaticDashboard({ html: HTML, css: "body{color:red}", js, overview, exportedAtIso: "2026-09-16T17:00:00Z" });
    expect(out).not.toContain('href="/styles.css"');
    expect(out).not.toContain('src="/app.js"');
    expect(out).toContain("<style>\nbody{color:red}\n</style>");
    // `$&` and `$1` in the page source must survive: a replacement *string* would expand them.
    expect(out).toContain(js);
    expect(out).toContain('window.__FIN_SNAPSHOT__ = {"overview":{"generatedAt":"2026-09-16T16:31:26.652Z"');
    expect(out).toContain('"exportedAt":"2026-09-16T17:00:00Z"');
    expect(out.match(/<\/script>/g)).toHaveLength(2);
    expect(out).toMatch(/<title>fin · paper-trading dashboard · snapshot 2026-09-1[67]<\/title>/);
  });

  it("refuses an index.html without the tags it rewrites", () => {
    expect(() => buildStaticDashboard({ html: "<html></html>", css: "", js: "", overview, exportedAtIso: "x" })).toThrow(/stylesheet tag/);
    expect(() => buildStaticDashboard({ html: HTML, css: "", js: "a = '</script>'", overview, exportedAtIso: "x" })).toThrow(/cannot be inlined/);
  });

  it("works on the real dashboard files and leaves nothing pointing at the server's assets", () => {
    const out = buildStaticDashboard({ html: read("index.html"), css: read("styles.css"), js: read("app.js"), overview, exportedAtIso: "2026-09-16T17:00:00Z" });
    expect(out).not.toMatch(/(href|src)="\/(styles\.css|app\.js)"/);
    // The page knows how to render a snapshot instead of polling.
    expect(read("app.js")).toContain("window.__FIN_SNAPSHOT__");
    expect(out.length).toBeGreaterThan(read("app.js").length + read("styles.css").length);
  });
});

describe("snapshotFileName", () => {
  it("stamps local date and time", () => {
    expect(snapshotFileName("2026-09-16T16:31:26.652Z")).toMatch(/^fin-dashboard-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
  });
});
