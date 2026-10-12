#!/usr/bin/env node
// SPDX-License-Identifier: MIT-0
// Render docs/THREAT_MODEL.md from docs/threat-model.tc.json (Threat Composer, schema 1).
//
// The JSON is canonical. Everything above "## 4. Did we do a good job" is generated
// from it; section 4 (evidence, open items, out of scope, review log) is prose kept
// by hand in the markdown and carried through unchanged.
//
//   node scripts/render-threat-model.mjs           # rewrite the markdown
//   node scripts/render-threat-model.mjs --check   # exit 1 if it is out of date (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(root, "docs/threat-model.tc.json");
const mdPath = join(root, "docs/THREAT_MODEL.md");
const SECTION4 = "## 4. Did we do a good job";

const tm = JSON.parse(readFileSync(jsonPath, "utf8"));
const current = readFileSync(mdPath, "utf8");
const at = current.indexOf(SECTION4);
if (at < 0) throw new Error(`${mdPath}: no "${SECTION4}" heading to carry section 4 from`);
const handWritten = current.slice(at);

const byOrder = (a, b) => a.displayOrder - b.displayOrder;
const threats = [...tm.threats].sort(byOrder);
const mitigations = [...tm.mitigations].sort(byOrder);
const assumptions = [...tm.assumptions].sort(byOrder);
const tag = (x) => x.tags[0];
const idTag = new Map([...threats, ...mitigations, ...assumptions].map((x) => [x.id, tag(x)]));
const meta = (t, key) => t.metadata?.find((m) => m.key === key)?.value;

const STRIDE = {
  S: "Spoofing",
  T: "Tampering",
  R: "Repudiation",
  I: "Information disclosure",
  D: "Denial of service",
  E: "Elevation of privilege",
};
const THREAT_STATUS = { threatResolved: "Resolved", threatIdentified: "Identified (open or residual)" };
const MITIGATION_STATUS = {
  mitigationResolved: "Implemented",
  mitigationInProgress: "In progress",
  mitigationIdentified: "Planned",
};

const linkedMitigations = (t) =>
  tm.mitigationLinks.filter((l) => l.linkedId === t.id).map((l) => idTag.get(l.mitigationId));
const linkedAssumptions = (t) =>
  tm.assumptionLinks.filter((l) => l.linkedId === t.id).map((l) => idTag.get(l.assumptionId));
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");
// The JSON descriptions open with their own "### " heading; section 1 supplies it.
const body = (s) => s.replace(/^### [^\n]*\n/, "").trim();
const count = (xs, status) => xs.filter((x) => x.status === status).length;

const out = [];
out.push(`# fin — threat model

*Canonical artifact:* \`docs/threat-model.tc.json\` (Threat Composer format, schema ${tm.schema}; import it at
https://awslabs.github.io/threat-composer or open it with the AWS Toolkit VS Code extension). This document is
rendered from it by \`scripts/render-threat-model.mjs\` and uses the same numbering (T = threat,
M = mitigation, AS = assumption). Change the JSON, then re-render; only section 4 is written by hand here.

*Method:* the AWS four-question threat model (what are we working on, what can go wrong, what are we
going to do about it, did we do a good job), threats written in the AWS threat grammar, STRIDE
classification, priorities High/Medium/Low. It is kept alongside the architecture description
(\`docs/ARCHITECTURE.md\`) and the scan policy (\`.ash/.ash.yaml\`), and reviewed before each release.

*Status:* ${threats.length} threats, ${mitigations.length} mitigations, ${assumptions.length} assumptions.
Threats: ${count(threats, "threatResolved")} resolved, ${count(threats, "threatIdentified")} identified with residual risk or planned mitigations.
Mitigations: ${count(mitigations, "mitigationResolved")} implemented, ${count(mitigations, "mitigationInProgress")} in progress, ${count(mitigations, "mitigationIdentified")} planned.
Open items are listed in section 4.

---

## 1. What are we working on

${body(tm.applicationInfo.description)}

### Components and trust boundaries
${body(tm.architecture.description)}

### Data flows and classification
${body(tm.dataflow.description)}

### Assumptions

${assumptions.map((a) => `- **${tag(a)}.** ${a.content}`).join("\n")}

---

## 2. What can go wrong

| # | Threat (grammar) | STRIDE | Priority | Status | Mitigations |
|---|---|---|---|---|---|
${threats
  .map(
    (t) =>
      `| ${tag(t)} | ${cell(t.statement)} | ${(meta(t, "STRIDE") ?? []).join("")} | ${meta(t, "Priority") ?? ""} | ${
        THREAT_STATUS[t.status] ?? t.status
      } | ${linkedMitigations(t).join(", ")} |`,
  )
  .join("\n")}

### Threat notes
`);
for (const t of threats) {
  const stride = (meta(t, "STRIDE") ?? []).map((s) => STRIDE[s] ?? s).join(", ");
  const lines = [`**${tag(t)} — ${stride}; priority ${meta(t, "Priority")}; ${THREAT_STATUS[t.status] ?? t.status}.**  `];
  const comments = meta(t, "Comments");
  if (comments) lines.push(`${comments}  `);
  const as = linkedAssumptions(t);
  lines.push(`Mitigations: ${linkedMitigations(t).join(", ")}.${as.length ? ` Assumptions: ${as.join(", ")}.` : ""}`);
  out.push(lines.join("\n") + "\n");
}
out.push(`---

## 3. What are we going to do about it

| # | Mitigation | Status |
|---|---|---|
${mitigations.map((m) => `| ${tag(m)} | ${cell(m.content)} | ${MITIGATION_STATUS[m.status] ?? m.status} |`).join("\n")}

---

`);

const rendered = out.join("\n") + handWritten;
if (process.argv.includes("--check")) {
  if (rendered !== current) {
    console.error("docs/THREAT_MODEL.md is out of date with docs/threat-model.tc.json — run scripts/render-threat-model.mjs");
    process.exit(1);
  }
  console.log("THREAT_MODEL.md is up to date");
} else {
  writeFileSync(mdPath, rendered);
  console.log(`wrote ${mdPath}`);
}
