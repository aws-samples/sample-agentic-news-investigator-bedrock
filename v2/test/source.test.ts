// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  edgarRef,
  decodeEntities,
  htmlToText,
  edgarDocuments,
  selectEdgarDocs,
  parseSubmissionHeader,
  readSource,
} from "../src/source.js";

// The real shape, trimmed: EDGAR's dissemination format, verified against
// 0001213900-26-097296 (Andretti Acquisition Corp. II 8-K, 2026-09-03).
const SUBMISSION = `<SEC-DOCUMENT>0001213900-26-097296.txt : 20260903
<SEC-HEADER>0001213900-26-097296.hdr.sgml : 20260903
ACCESSION NUMBER:\t\t0001213900-26-097296
CONFORMED SUBMISSION TYPE:\t8-K
CONFORMED PERIOD OF REPORT:\t20260903
ITEM INFORMATION:\t\tEntry into a Material Definitive Agreement
ITEM INFORMATION:\t\tFinancial Statements and Exhibits
FILED AS OF DATE:\t\t20260903

FILER:

\tCOMPANY DATA:
\t\tCOMPANY CONFORMED NAME:\t\t\tAndretti Acquisition Corp. II
\t\tCENTRAL INDEX KEY:\t\t\t0002025341
</SEC-HEADER>
<DOCUMENT>
<TYPE>8-K
<SEQUENCE>1
<FILENAME>ea0304637-8k_andretti2.htm
<DESCRIPTION>CURRENT REPORT
<TEXT>
<html><ix:header><ix:references>noise noise noise</ix:references></ix:header>
<body><p>Item 1.01 Entry into a Material Definitive Agreement.</p>
<p>On September&nbsp;3, 2026 the Company entered into agreements covering
5,000,000 Class&nbsp;A ordinary shares.</p></body></html>
</TEXT>
</DOCUMENT>
<DOCUMENT>
<TYPE>EX-10.1
<SEQUENCE>2
<FILENAME>ea030463701ex10-1.htm
<DESCRIPTION>FORM OF NON-REDEMPTION AGREEMENT
<TEXT>
<html><body><p>forty pages of covenants</p></body></html>
</TEXT>
</DOCUMENT>
<DOCUMENT>
<TYPE>EX-99.1
<SEQUENCE>3
<FILENAME>ea030463701ex99-1.htm
<DESCRIPTION>PRESS RELEASE
<TEXT>
<html><body><p>Revenue rose 12% to $4.1 million.</p></body></html>
</TEXT>
</DOCUMENT>
<DOCUMENT>
<TYPE>EX-101.SCH
<SEQUENCE>4
<FILENAME>pole-20260903.xsd
<DESCRIPTION>XBRL SCHEMA FILE
<TEXT>
<xsd:schema/>
</TEXT>
</DOCUMENT>`;

describe("edgarRef", () => {
  it("derives the submission address from an Atom index link", () => {
    const r = edgarRef(
      "https://www.sec.gov/Archives/edgar/data/2025341/000121390026097296/0001213900-26-097296-index.htm",
    );
    expect(r).toEqual({
      cik: "2025341",
      accession: "0001213900-26-097296",
      submissionUrl:
        "https://www.sec.gov/Archives/edgar/data/2025341/000121390026097296/0001213900-26-097296.txt",
    });
  });

  it("accepts a bare directory url and rejects everything else", () => {
    expect(
      edgarRef("https://www.sec.gov/Archives/edgar/data/320193/000032019326000081/")?.accession,
    ).toBe("0000320193-26-000081");
    expect(edgarRef("https://www.nhc.noaa.gov/text/MIATCPEP1.shtml")).toBeNull();
    expect(edgarRef("https://www.sec.gov/news/press-release/2026-101")).toBeNull();
  });
});

describe("decodeEntities", () => {
  it("handles named, decimal and hex references", () => {
    // &nbsp; becomes an ordinary space so the whitespace collapse below can see it.
    expect(decodeEntities("AT&amp;T &#8217;s &#x201c;deal&#x201d;&nbsp;done")).toBe(
      "AT&T \u2019s \u201cdeal\u201d done",
    );
  });

  it("leaves an unknown entity alone rather than eating it", () => {
    expect(decodeEntities("&notanentity; &#x110000;")).toBe("&notanentity; &#x110000;");
  });
});

describe("htmlToText", () => {
  it("drops the inline-XBRL header, which is the first few hundred tags of a filing", () => {
    const t = htmlToText(
      "<html><ix:header><ix:resources>0002025341 iso4217:USD xbrli:shares</ix:resources></ix:header><body><p>Item 3.01 Notice of Delisting.</p></body></html>",
    );
    expect(t).toBe("Item 3.01 Notice of Delisting.");
    expect(t).not.toContain("xbrli");
  });

  it("keeps block structure, collapses runs of space and non-breaking space", () => {
    // Table CELLS join on one line and ROWS break, which is what makes a filing's
    // cover page ("Cayman Islands  001-42268  98-1792547") read as one line.
    expect(
      htmlToText("<tr><td>Cayman Islands</td><td>001-42268</td></tr><p>On September&nbsp;3</p>"),
    ).toBe("Cayman Islands 001-42268\nOn September 3");
    expect(htmlToText("<p>two   three</p><br>four")).toBe("two three\n\nfour");
  });
});

describe("parseSubmissionHeader", () => {
  it("reads the plain-text dissemination header", () => {
    expect(parseSubmissionHeader(SUBMISSION)).toEqual({
      form: "8-K",
      filer: "Andretti Acquisition Corp. II",
      cik: "0002025341",
      filed: "20260903",
      period: "20260903",
      items: ["Entry into a Material Definitive Agreement", "Financial Statements and Exhibits"],
    });
  });

  it("ignores anything after the header, so a document body cannot spoof it", () => {
    const spoofed = SUBMISSION + "\nCONFORMED SUBMISSION TYPE:\t10-K\n";
    expect(parseSubmissionHeader(spoofed).form).toBe("8-K");
  });
});

describe("edgarDocuments", () => {
  it("splits the submission into typed documents", () => {
    const docs = edgarDocuments(SUBMISSION);
    expect(docs.map((d) => `${d.sequence}:${d.type}`)).toEqual([
      "1:8-K",
      "2:EX-10.1",
      "3:EX-99.1",
      "4:EX-101.SCH",
    ]);
    expect(docs[0].description).toBe("CURRENT REPORT");
    expect(docs[0].filename).toBe("ea0304637-8k_andretti2.htm");
  });

  it("still yields the primary document when the stream was cut mid-exhibit", () => {
    const cut = SUBMISSION.slice(0, SUBMISSION.indexOf("EX-99.1") + 40);
    const docs = edgarDocuments(cut);
    expect(docs[0].type).toBe("8-K");
    expect(docs.length).toBe(3);
  });
});

describe("selectEdgarDocs", () => {
  it("reads the filing and the press release, and only lists the rest", () => {
    const { keep, listed } = selectEdgarDocs(edgarDocuments(SUBMISSION));
    expect(keep.map((d) => d.type)).toEqual(["8-K", "EX-99.1"]);
    // Forty pages of covenants and an XBRL schema are named, not spent tokens on.
    expect(listed.map((d) => d.type)).toEqual(["EX-10.1", "EX-101.SCH"]);
  });
});

describe("readSource", () => {
  it("refuses a rewritten-in-place page in the bench, and says why", async () => {
    const r = await readSource(
      { url: "https://www.nhc.noaa.gov/text/MIATCPEP1.shtml", body_s3_uri: null },
      { bench: true },
    );
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/rewrites in place/);
  });

  it("reports an event with nothing to read instead of throwing", async () => {
    const r = await readSource({ url: "", body_s3_uri: null });
    expect(r).toEqual({ error: "this event carries no source document (no url, no archived body)" });
  });
});
