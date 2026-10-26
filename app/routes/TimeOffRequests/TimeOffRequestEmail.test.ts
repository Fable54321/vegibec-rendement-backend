import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewTimeOffRequestEmail,
  buildTimeOffApprovalUrl,
  buildTimeOffReviewEmail,
  buildUpcomingTimeOffEmail,
  TIME_OFF_REQUEST_EMAIL_RECIPIENT,
} from "./TimeOffRequestEmail";

test("builds the approved time-off summary for the next seven days", () => {
  const email = buildUpcomingTimeOffEmail(
    [
      {
        id: 50,
        requester_user_id: 13,
        requested_dates: ["2026-10-26", "2026-10-27"],
        status: "approved",
        name: "Marie",
        surname: "Tremblay",
      },
      {
        id: 51,
        requester_user_id: null,
        requested_dates: ["2026-11-01"],
        status: "pending",
        name: "Camille Invitée",
      },
    ],
    "2026-10-26",
    "2026-11-01",
  );

  assert.match(email.subject, /7 prochains jours/);
  assert.match(email.text, /Tremblay Marie/);
  assert.match(email.text, /Approuvée/);
  assert.match(email.text, /du 26 octobre 2026 au 27 octobre 2026/);
  assert.match(email.html, /Camille Invitée/);
  assert.match(email.html, /En attente/);
  assert.match(email.html, /1 novembre 2026/);
});

test("builds an empty approved time-off summary", () => {
  const email = buildUpcomingTimeOffEmail([], "2026-10-26", "2026-11-01");

  assert.match(email.text, /Aucune demande de congé/);
  assert.match(email.html, /Aucune demande de congé/);
});

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
  assert.match(email.subject, /Tremblay Marie/);
  assert.match(email.text, /20 octobre 2026/);
  assert.match(email.text, /Banque de vacances/);
  assert.match(email.html, /marie@example\.com/);
  assert.match(
    email.text,
    /https:\/\/vegibec-portail\.com\/approbation-conge\/42/,
  );
  assert.match(
    email.html,
    /href="https:\/\/vegibec-portail\.com\/approbation-conge\/42"/,
  );
});

test("builds a new request notification for a guest", () => {
  const email = buildNewTimeOffRequestEmail(
    {
      id: 48,
      requester_user_id: null,
      requested_dates: ["2026-11-10"],
      payment_preference: "no-preference",
    },
    {
      name: "Camille Invitée",
      email: "camille@example.com",
    },
  );

  assert.match(email.subject, /Camille Invitée/);
  assert.match(email.text, /camille@example\.com/);
  assert.match(email.html, /Camille Invitée/);
});

test("builds the approval URL from the request ID", () => {
  assert.equal(
    buildTimeOffApprovalUrl(987),
    "https://vegibec-portail.com/approbation-conge/987",
  );
});

test("groups consecutive requested dates into inclusive ranges", () => {
  const email = buildNewTimeOffRequestEmail(
    {
      id: 44,
      requester_user_id: 9,
      requested_dates: [
        "2026-10-25",
        "2026-10-19",
        "2026-10-21",
        "2026-10-20",
        "2026-10-22",
        "2026-10-24",
        "2026-10-23",
      ],
      payment_preference: "unpaid",
    },
    { name: "Louis", surname: "Roy" },
  );

  assert.match(email.text, /du 19 octobre 2026 au 25 octobre 2026/);
  assert.match(email.html, /du 19 octobre 2026 au 25 octobre 2026/);
  assert.doesNotMatch(email.text, /- 20 octobre 2026/);
});

test("keeps separate dates and date ranges distinct", () => {
  const email = buildNewTimeOffRequestEmail(
    {
      id: 45,
      requester_user_id: 10,
      requested_dates: ["2026-10-19", "2026-10-20", "2026-10-25"],
      payment_preference: "overtime-bank",
    },
    { name: "Anne", surname: "Roy" },
  );

  assert.match(email.text, /- du 19 octobre 2026 au 20 octobre 2026/);
  assert.match(email.text, /- 25 octobre 2026/);
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

test("builds an approval email for the requester", () => {
  const email = buildTimeOffReviewEmail(
    {
      id: 46,
      requester_user_id: 11,
      requested_dates: ["2026-11-02", "2026-11-03"],
      status: "approved",
      review_note: "Approuvé par la direction",
    },
    { name: "Marie", surname: "Tremblay" },
  );

  assert.match(email.subject, /demande de congé a été approuvée/);
  assert.match(email.text, /Bonjour Tremblay Marie/);
  assert.match(email.text, /du 2 novembre 2026 au 3 novembre 2026/);
  assert.match(email.text, /Statut : Approuvée/);
  assert.match(email.html, /Approuvé par la direction/);
});

test("builds a refusal email and escapes its review note", () => {
  const email = buildTimeOffReviewEmail(
    {
      id: 47,
      requester_user_id: 12,
      requested_dates: ["2026-11-05"],
      status: "rejected",
      review_note: "Conflit <horaire> & équipe",
    },
    { username: "jroy" },
  );

  assert.match(email.subject, /demande de congé a été refusée/);
  assert.match(email.text, /Statut : Refusée/);
  assert.match(email.text, /Conflit <horaire> & équipe/);
  assert.match(email.html, /Conflit &lt;horaire&gt; &amp; équipe/);
});
