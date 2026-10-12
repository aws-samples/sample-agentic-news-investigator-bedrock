// SPDX-License-Identifier: MIT-0
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { ddb } from "./ledger.js";

const s3 = new S3Client({ region: config.region });
const TTL_DAYS = 90;

/** v1 convention: pk NEWS#<id>, sk EVT#<ts>#<stage>. */
export async function putAudit(
  newsId: string,
  stage: string,
  payload: unknown,
  opts: { pkPrefix?: string } = {},
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: {
        // Bench rows use pkPrefix "BENCH#" so they fall outside every NEWS# scan
        // (letter, dashboard, report) and never read as live news.
        pk: `${opts.pkPrefix ?? "NEWS#"}${newsId}`,
        sk: `EVT#${new Date().toISOString()}#${stage}`,
        stage,
        payload,
        ttl: Math.floor(Date.now() / 1000) + TTL_DAYS * 86400,
      },
    }),
  );
}

/**
 * At-least-once SQS delivery -> claim each news id once. Returns false when
 * another delivery already claimed it.
 */
export async function claimNews(newsId: string): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: config.table,
        Item: {
          pk: `NEWS#${newsId}`,
          sk: "CLAIM",
          claimed_at: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + TTL_DAYS * 86400,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** Full agent trajectory to S3 (the paper's "interpretable traces"). */
export async function putTranscript(
  newsId: string,
  messages: unknown[],
): Promise<string | null> {
  if (!config.transcriptBucket) return null;
  // One prefix per arm (transcripts/<arm>/<day>/<id>.json); before the arms
  // registry the first arm wrote to transcripts/<day>/ with no arm segment.
  const key = `transcripts/${config.arm}/${new Date().toISOString().slice(0, 10)}/${newsId}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: config.transcriptBucket,
      Key: key,
      Body: JSON.stringify(messages, null, 1),
      ContentType: "application/json",
    }),
  );
  return `s3://${config.transcriptBucket}/${key}`;
}
