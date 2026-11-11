import assert from "node:assert/strict";
import test from "node:test";
import { resolveSigningDate } from "./signingDate";

test("resolveSigningDate keeps the submission timestamp when no date is supplied", () => {
  const submissionDate = new Date("2026-11-11T16:42:10.000Z");
  const result = resolveSigningDate(undefined, submissionDate);

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.isManual, false);
    assert.equal(result.date.toISOString(), submissionDate.toISOString());
  }
});

test("resolveSigningDate accepts a manual calendar date", () => {
  const result = resolveSigningDate("2026-10-05");

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.isManual, true);
    assert.equal(result.date.toISOString(), "2026-10-05T12:00:00.000Z");
  }
});

test("resolveSigningDate rejects malformed and impossible dates", () => {
  for (const value of ["2026-02-30", "05-10-2026", "2026-2-3", 20261005]) {
    const result = resolveSigningDate(value);
    assert.equal(result.ok, false);
  }
});
