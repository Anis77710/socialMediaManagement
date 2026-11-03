import type { EmailMessage } from "../../providers/email/types.js";

function formatMinutes(minutes: number): string {
  return minutes >= 60 ? `${Math.round(minutes / 60)} hour(s)` : `${minutes} minute(s)`;
}

export function inviteEmail(input: {
  email: string;
  role: string;
  inviteUrl: string;
  expiresAt: Date;
}): EmailMessage {
  return {
    to: input.email,
    subject: "You have been invited to the Redflie admin console",
    text: [
      `You have been invited to the Redflie admin console as ${input.role}.`,
      "",
      `Accept your invitation: ${input.inviteUrl}`,
      "",
      `This link expires at ${input.expiresAt.toISOString()}.`,
      "If you were not expecting this invitation, ignore this email.",
    ].join("\n"),
  };
}

export function passwordResetEmail(input: {
  email: string;
  resetUrl: string;
  expiresAt: Date;
}): EmailMessage {
  return {
    to: input.email,
    subject: "Reset your Redflie admin password",
    text: [
      "A password reset was requested for your Redflie admin account.",
      "",
      `Reset your password: ${input.resetUrl}`,
      "",
      `This link expires at ${input.expiresAt.toISOString()}.`,
      "If you did not request this, ignore this email; your password is unchanged.",
    ].join("\n"),
  };
}

export function passwordChangedEmail(email: string): EmailMessage {
  return {
    to: email,
    subject: "Your Redflie admin password was changed",
    text: "Your Redflie admin password was changed. If this was not you, contact a super admin immediately.",
  };
}

export function lockedOutEmail(input: {
  email: string;
  minutes: number;
  ip: string;
}): EmailMessage {
  return {
    to: input.email,
    subject: "Redflie admin account temporarily locked",
    text: [
      "Your Redflie admin account was temporarily locked after repeated failed sign-in attempts.",
      `Lockout duration: ${formatMinutes(input.minutes)}.`,
      `Source IP: ${input.ip}.`,
      "",
      "If this was not you, reset your password once the lockout expires.",
    ].join("\n"),
  };
}

export function newLoginEmail(input: {
  email: string;
  ip: string;
  at: Date;
}): EmailMessage {
  return {
    to: input.email,
    subject: "New sign-in to your Redflie admin account",
    text: [
      "Your Redflie admin account was signed in from a new IP address.",
      "",
      `IP: ${input.ip}`,
      `Time: ${input.at.toISOString()}`,
      "",
      "If this was not you, reset your password and revoke your sessions.",
    ].join("\n"),
  };
}

export function securityAlertEmail(input: {
  email: string;
  message: string;
  actorEmail?: string;
}): EmailMessage {
  return {
    to: input.email,
    subject: "Redflie admin security alert",
    text: [
      input.message,
      ...(input.actorEmail ? ["", `Actor: ${input.actorEmail}`] : []),
    ].join("\n"),
  };
}
