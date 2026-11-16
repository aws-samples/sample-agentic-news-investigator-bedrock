// SPDX-License-Identifier: MIT-0
import os from "node:os";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb } from "./ledger.js";

/**
 * STATE/HEARTBEAT in the arm's own table: proof of life that does not depend on the machine the
 * worker runs on (a supervisor's status and a log file's mtime only work on the worker's host).
 * Written at most once a minute; a failed write never stops the worker.
 */
const startedAt = new Date().toISOString();
let lastWriteMs = 0;

export async function heartbeat(phase: string): Promise<void> {
  if (Date.now() - lastWriteMs < 60_000) return;
  lastWriteMs = Date.now();
  await ddb
    .send(
      new PutCommand({
        TableName: config.table,
        Item: {
          pk: "STATE",
          sk: "HEARTBEAT",
          arm: config.arm,
          at: new Date().toISOString(),
          started_at: startedAt,
          host: os.hostname(),
          pid: process.pid,
          phase,
          release: process.env.FIN_RELEASE ?? null,
        },
      }),
    )
    .catch((e) => console.warn("[heartbeat] write failed:", String(e).slice(0, 160)));
}
