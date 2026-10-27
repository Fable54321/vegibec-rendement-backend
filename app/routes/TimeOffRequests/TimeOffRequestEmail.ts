import { sendEmail } from "../Visitors/Utils/testSMTP";

export const TIME_OFF_REQUEST_EMAIL_RECIPIENTS = [ 
  "programmation@vegibec.com",
  "timothebissonnette@gmail.com"
];
const TIME_OFF_APPROVAL_BASE_URL =
  "https://vegibec-portail.com/approbation-conge";

type TimeOffRequest = {
  id: number | string;
  requester_user_id: number | string | null;
  requested_dates: Array<string | Date>;
  reason?: string | null;
  payment_preference?: string | null;
  payment_preference_other?: string | null;
  status?: string | null;
  review_note?: string | null;
  created_at?: string | Date | null;
};

type TimeOffRequester = {
  name?: string | null;
  surname?: string | null;
  username?: string | null;
  email?: string | null;
};

export type TimeOffRequestEmail = {
  subject: string;
  text: string;
  html: string;
};

export const buildTimeOffApprovalUrl = (requestId: number | string): string =>
  `${TIME_OFF_APPROVAL_BASE_URL}/${encodeURIComponent(String(requestId))}`;

const paymentPreferenceLabels: Record<string, string> = {
  "overtime-bank": "Banque d'heures supplémentaires",
  "vacation-bank": "Banque de vacances",
  "no-preference": "Pas de préférence",
  unpaid: "Congé sans solde",
  other: "Autre",
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const formatDate = (value: string | Date): string => {
  const rawDate =
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return rawDate;
  }

  return new Intl.DateTimeFormat("fr-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${rawDate}T00:00:00Z`));
};

const toIsoDate = (value: string | Date): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

const formatDateRanges = (values: Array<string | Date>): string[] => {
  const dates = [...new Set(values.map(toIsoDate))].sort();
  const ranges: Array<{ start: string; end: string }> = [];

  for (const date of dates) {
    const currentRange = ranges[ranges.length - 1];

    if (!currentRange) {
      ranges.push({ start: date, end: date });
      continue;
    }

    const previousDay = Date.parse(`${currentRange.end}T00:00:00Z`);
    const currentDay = Date.parse(`${date}T00:00:00Z`);

    if (
      Number.isFinite(previousDay) &&
      Number.isFinite(currentDay) &&
      currentDay - previousDay === 24 * 60 * 60 * 1000
    ) {
      currentRange.end = date;
    } else {
      ranges.push({ start: date, end: date });
    }
  }

  return ranges.map(({ start, end }) =>
    start === end
      ? formatDate(start)
      : `du ${formatDate(start)} au ${formatDate(end)}`,
  );
};

const getRequesterName = (
  request: TimeOffRequest,
  requester: TimeOffRequester,
): string => {
  const fullName = [requester.surname, requester.name]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" ");

  return (
    fullName ||
    requester.username?.trim() ||
    (request.requester_user_id
      ? `Utilisateur #${request.requester_user_id}`
      : "Invité")
  );
};

const getPaymentPreference = (request: TimeOffRequest): string => {
  const preference = request.payment_preference?.trim() || "Non précisée";
  const label = paymentPreferenceLabels[preference] ?? preference;
  const other = request.payment_preference_other?.trim();

  return preference === "other" && other ? `${label} — ${other}` : label;
};

export const buildNewTimeOffRequestEmail = (
  request: TimeOffRequest,
  requester: TimeOffRequester,
): TimeOffRequestEmail => {
  const requesterName = getRequesterName(request, requester);
  const requesterEmail = requester.email?.trim() || "Non disponible";
  const dates = formatDateRanges(request.requested_dates);
  const reason = request.reason?.trim() || "Aucune raison précisée";
  const paymentPreference = getPaymentPreference(request);
  const approvalUrl = buildTimeOffApprovalUrl(request.id);
  const safeSubjectName = requesterName.replace(/[\r\n]+/g, " ");
  const subject = `Nouvelle demande de congé — ${safeSubjectName}`;
  const text = [
    "Une nouvelle demande de congé a été soumise.",
    "",
    `Employé : ${requesterName}`,
    `Courriel : ${requesterEmail}`,
    "Dates demandées :",
    ...dates.map((date) => `- ${date}`),
    `Préférence de rémunération : ${paymentPreference}`,
    `Raison : ${reason}`,
    "",
    `Approuver ou consulter cette demande : ${approvalUrl}`,
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2 style="margin-bottom: 16px;">Nouvelle demande de congé</h2>
      
      <p><strong>Employé :</strong> ${escapeHtml(requesterName)}</p>
      <p><strong>Courriel :</strong> ${escapeHtml(requesterEmail)}</p>
      <p><strong>Dates demandées :</strong></p>
      <ul>${dates.map((date) => `<li>${escapeHtml(date)}</li>`).join("")}</ul>
      <p><strong>Préférence de rémunération :</strong> ${escapeHtml(paymentPreference)}</p>
      <p><strong>Raison :</strong><br />${escapeHtml(reason).replace(/\n/g, "<br />")}</p>
      <p style="margin-top: 24px;">
        <a href="${escapeHtml(approvalUrl)}" style="display: inline-block; padding: 12px 18px; border-radius: 6px; background: #166534; color: #ffffff; text-decoration: none; font-weight: bold;">
          Approuver ou consulter la demande
        </a>
      </p>
      <p style="font-size: 12px; color: #6b7280;">${escapeHtml(approvalUrl)}</p>
    </div>
  `.trim();

  return { subject, text, html };
};

export const buildTimeOffReviewEmail = (
  request: TimeOffRequest,
  requester: TimeOffRequester,
): TimeOffRequestEmail => {
  const approved = request.status === "approved";
  const decision = approved ? "approuvée" : "refusée";
  const statusLabel = approved ? "Approuvée" : "Refusée";
  const requesterName = getRequesterName(request, requester);
  const dates = formatDateRanges(request.requested_dates);
  const reviewNote = request.review_note?.trim();
  const subject = `Demande de congé ${decision}`;
  const text = [
    `Bonjour ${requesterName},`,
    "",
    `Votre demande de congé a été ${decision}.`,
    "",
    "Dates demandées :",
    ...dates.map((date) => `- ${date}`),
    
    ...(reviewNote ? [`Raison ou notes : ${reviewNote}`] : []),
    "",
    "Merci",
    
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <p>Bonjour ${escapeHtml(requesterName)},</p>
      <p>Votre demande de congé a été <strong>${decision}</strong>.</p>
      <p><strong>Dates demandées :</strong></p>
      <ul>${dates.map((date) => `<li>${escapeHtml(date)}</li>`).join("")}</ul>
      
      ${
        reviewNote
          ? `<p><strong>Raison ou notes :</strong><br />${escapeHtml(reviewNote).replace(/\n/g, "<br />")}</p>`
          : ""
      }
      <p>Merci</p>
    </div>
  `.trim();

  return { subject, text, html };
};

export const sendNewTimeOffRequestEmailSafely = async (
  request: TimeOffRequest,
  requester: TimeOffRequester,
): Promise<void> => {
  try {
    const email = buildNewTimeOffRequestEmail(request, requester);
    const emailInfo = await sendEmail({
      to: TIME_OFF_REQUEST_EMAIL_RECIPIENTS,
      fromLabel: "Vegibec - Demandes de congé",
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    console.log("Time off request email relay response:", {
      requestId: request.id,
      to: TIME_OFF_REQUEST_EMAIL_RECIPIENTS,
      messageId: emailInfo.messageId,
      accepted: emailInfo.accepted,
      rejected: emailInfo.rejected,
      response: emailInfo.response,
    });
  } catch (error) {
    console.error("Time off request email failed:", {
      requestId: request.id,
      to: TIME_OFF_REQUEST_EMAIL_RECIPIENTS,
      error,
    });
  }
};

export const sendTimeOffReviewEmailSafely = async (
  request: TimeOffRequest,
  requester: TimeOffRequester,
): Promise<void> => {
  const recipient = requester.email?.trim();

  if (!recipient) {
    console.error("Time off review email skipped: requester has no email", {
      requestId: request.id,
      requesterUserId: request.requester_user_id,
    });
    return;
  }

  try {
    const email = buildTimeOffReviewEmail(request, requester);
    const emailInfo = await sendEmail({
      to: recipient,
      fromLabel: "Vegibec - Demandes de congé",
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    console.log("Time off review email relay response:", {
      requestId: request.id,
      to: recipient,
      messageId: emailInfo.messageId,
      accepted: emailInfo.accepted,
      rejected: emailInfo.rejected,
      response: emailInfo.response,
    });
  } catch (error) {
    console.error("Time off review email failed:", {
      requestId: request.id,
      to: recipient,
      error,
    });
  }
};
