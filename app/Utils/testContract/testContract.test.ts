import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import testContractRouter from "./testContract";

type BinaryParserCallback = (error: Error | null, body: Buffer) => void;

const binaryParser = (
  res: import("superagent").Response,
  callback: BinaryParserCallback,
): void => {
  const chunks: Buffer[] = [];

  res.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  res.on("end", () => {
    callback(null, Buffer.concat(chunks));
  });

  res.on("error", (error: Error) => {
    callback(error, Buffer.alloc(0));
  });
};

test("GET /test/debug/contract-preview/impaut returns a PDF preview", async () => {
  const app = express();
  app.use("/test", testContractRouter);

  const response = await request(app)
    .get("/test/debug/contract-preview/impaut")
    .buffer(true)
    .parse(binaryParser);

  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] ?? "", /^application\/pdf\b/);
  assert.equal(
    response.headers["content-disposition"],
    'inline; filename="ImpAut-preview.pdf"',
  );
  assert.ok(Buffer.isBuffer(response.body));
  assert.equal(response.body.subarray(0, 5).toString("utf8"), "%PDF-");
  assert.ok(response.body.length > 1_000);
});
