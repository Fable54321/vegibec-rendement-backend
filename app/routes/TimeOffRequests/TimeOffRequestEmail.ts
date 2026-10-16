import { sendEmail } from "../Visitors/Utils/testSMTP";

export const TIME_OFF_REQUEST_EMAIL_RECIPIENT = "programmation@vegibec.com";

type TimeOffRequest = {
  id: number | string;
  requester_user_id: number | string;
  requested_dates: Array<string | Date>;
  reason?: string | null;
  payment_preference?: string | null;
  payment_preference_other?: string | null;
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

const paymentPreferenceLabels: Record<string, string> = {
  "overtime-bank": "Banque d'heures supplémentaires",
  "vacation-bank": "Banque de vacances",
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

const getRequesterName = (
  request: TimeOffRequest,
  requester: TimeOffRequester,
): string => {
  const fullName = [requester.name, requester.surname]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" ");

  return (
    fullName ||
    requester.username?.trim() ||
    `Utilisateur #${request.requester_user_id}`
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
  const dates = request.requested_dates.map(formatDate);
  const reason = request.reason?.trim() || "Aucune raison précisée";
  const paymentPreference = getPaymentPreference(request);
  const safeSubjectName = requesterName.replace(/[\r\n]+/g, " ");
  const subject = `Nouvelle demande de congé — ${safeSubjectName}`;
  const text = [
    "Une nouvelle demande de congé a été soumise.",
    "",
    `Demande : #${request.id}`,
    `Employé : ${requesterName}`,
    `Courriel : ${requesterEmail}`,
    "Dates demandées :",
    ...dates.map((date) => `- ${date}`),
    `Préférence de paiement : ${paymentPreference}`,
    `Raison : ${reason}`,
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2 style="margin-bottom: 16px;">Nouvelle demande de congé</h2>
      <p><strong>Demande :</strong> #${escapeHtml(String(request.id))}</p>
      <p><strong>Employé :</strong> ${escapeHtml(requesterName)}</p>
      <p><strong>Courriel :</strong> ${escapeHtml(requesterEmail)}</p>
      <p><strong>Dates demandées :</strong></p>
      <ul>${dates.map((date) => `<li>${escapeHtml(date)}</li>`).join("")}</ul>
      <p><strong>Préférence de paiement :</strong> ${escapeHtml(paymentPreference)}</p>
      <p><strong>Raison :</strong><br />${escapeHtml(reason).replace(/\n/g, "<br />")}</p>
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
      to: TIME_OFF_REQUEST_EMAIL_RECIPIENT,
      fromLabel: "Vegibec - Demandes de congé",
      subject: email.subject,
      text: email.text,
      html: email.html,
    });

    console.log("Time off request email relay response:", {
      requestId: request.id,
      to: TIME_OFF_REQUEST_EMAIL_RECIPIENT,
      messageId: emailInfo.messageId,
      accepted: emailInfo.accepted,
      rejected: emailInfo.rejected,
      response: emailInfo.response,
    });
  } catch (error) {
    console.error("Time off request email failed:", {
      requestId: request.id,
      to: TIME_OFF_REQUEST_EMAIL_RECIPIENT,
      error,
    });
  }
};
