import assert from "node:assert/strict"
import test from "node:test"

import {
  hashAgreementSigningToken,
  readAgreementSigningToken,
} from "./agreementSigningSessions"

const token = "A".repeat(43)

test("reads only a correctly shaped bearer signing token", () => {
  assert.equal(readAgreementSigningToken(`Bearer ${token}`), token)
  assert.equal(readAgreementSigningToken(token), null)
  assert.equal(readAgreementSigningToken("Bearer too-short"), null)
  assert.equal(readAgreementSigningToken(`bearer ${token}`), null)
})

test("hashes signing tokens before persistence", () => {
  const hash = hashAgreementSigningToken(token)

  assert.equal(hash.length, 64)
  assert.notEqual(hash, token)
  assert.equal(hash, hashAgreementSigningToken(token))
  assert.notEqual(hash, hashAgreementSigningToken("B".repeat(43)))
})
