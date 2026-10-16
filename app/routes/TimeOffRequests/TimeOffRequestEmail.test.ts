import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewTimeOffRequestEmail,
  TIME_OFF_REQUEST_EMAIL_RECIPIENT,
} from "./TimeOffRequestEmail";

test("builds the new time-off request notification", () => {
  const email = buildNewTimeOffRequestEmail(
    {
      id: 42,
      requester_user_id: 7,
      requested_dates: ["2026-10-20", "2026-10-21"],
      reason: "Rendez-vous familial",
      payment_preference: "vacation-bank",
    },
    {
      name: "Marie",
      surname: "Tremblay",
      email: "marie@example.com",
    },
  );

  assert.equal(TIME_OFF_REQUEST_EMAIL_RECIPIENT, "programmation@vegibec.com");
  assert.match(email.subject, /Marie Tremblay/);
  assert.match(email.text, /20 octobre 2026/);
  assert.match(email.text, /Banque de vacances/);
  assert.match(email.html, /marie@example\.com/);
});

test("escapes user-provided values in the HTML email", () => {
  const email = buildNewTimeOffRequestEmail(
    {
      id: 43,
      requester_user_id: 8,
      requested_dates: ["2026-10-22"],
      reason: "<script>alert('test')</script>",
      payment_preference: "other",
      payment_preference_other: "Échange & reprise",
    },
    {
      name: "Jean <Admin>",
      surname: "Roy",
    },
  );

  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.match(email.html, /Échange &amp; reprise/);
});
