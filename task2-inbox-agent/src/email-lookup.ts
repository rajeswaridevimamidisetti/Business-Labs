import { syntheticEmails } from "./dataset.js";

export const inboxEmails = syntheticEmails();

export function findEmail(emailId: unknown): (typeof inboxEmails)[number] | undefined {
  return typeof emailId === "string" ? inboxEmails.find((item) => item.id === emailId) : undefined;
}
