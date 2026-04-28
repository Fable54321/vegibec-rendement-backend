import dotenv from "dotenv";
import fs from "fs";
import nodemailer from "nodemailer";
import path from "path";

const findEnvPath = (startDirectory: string): string | undefined => {
  let currentDirectory = startDirectory;

  while (true) {
    const envPath = path.join(currentDirectory, ".env");

    if (fs.existsSync(envPath)) {
      return envPath;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
};

dotenv.config({
  path: findEnvPath(__dirname),
  quiet: true,
});

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const parsePort = (value: string): number => {
  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SMTP_PORT must be a valid TCP port. Received: ${value}`);
  }

  return port;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean value, received: ${value}`);
};

const host = requiredEnv("SMTP_HOST");
const port = parsePort(process.env.SMTP_PORT?.trim() ?? "587");
const secure = parseBoolean(process.env.SMTP_SECURE, port === 465);
const user = requiredEnv("SMTP_USER");
const pass = requiredEnv("SMTP_PASS");
const from = process.env.SMTP_FROM?.trim() || user;
const to = requiredEnv("SMTP_TEST_TO");

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: {
    user,
    pass,
  },
  requireTLS: !secure,
});

const run = async (): Promise<void> => {
  console.log(`Testing SMTP relay ${host}:${port} as ${user}`);

  await transporter.verify();
  console.log("SMTP connection and authentication succeeded.");

  const info = await transporter.sendMail({
    from,
    to,
    subject: `SMTP relay test - ${new Date().toISOString()}`,
    text: "SMTP relay test message.",
    html: "<p>SMTP relay test message.</p>",
  });

  console.log("SMTP test email accepted by relay.");
  console.log({
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  });
};

run().catch((error: unknown) => {
  console.error("SMTP test failed.");
  console.error(error);
  process.exitCode = 1;
});
