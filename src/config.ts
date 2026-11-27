import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;
export const CLIENT_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
export const SCOPES = "openid email offline_access midjo.api";

export function origin(value: string, label = "URL"): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTPS origin`); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error(`${label} must be an HTTPS origin; HTTP is permitted only on loopback`);
  }
  return url.origin;
}

export function sessionPath(): string {
  const profile = process.env.MIDJOCTL_PROFILE;
  if (profile !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
    throw new Error("Profile names must contain 1..64 letters, numbers, underscores or hyphens");
  }
  return process.env.MIDJOCTL_SESSION_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "lookandtry", "midjoctl", profile ? `${profile}.json` : "session.json");
}

export function integer(value: string, label: string, min: number, max: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

export const apiOrigin = origin;
