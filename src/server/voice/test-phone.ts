/**
 * Allowlisted test handset for real outbound dials from the harness page.
 * The number is never returned to the browser; only whether one is configured.
 */

import { peekDevEnvValues, readDevEnvFile, type DevEnvFs } from "./dev-env-file.js";

const ENV_NAMES = ["VOICE_HARNESS_TEST_PHONE", "VOICE_HARNESS_SECONDARY_TEST_PHONE"] as const;

export function peekTestPhoneConfigured(
  env: Record<string, string | undefined> = process.env,
  fs?: DevEnvFs,
): boolean {
  return loadAllowlistedTestPhone(env, fs) !== undefined;
}

/** Synthetic +155501xx test number; it must be present in the development environment file. */
export function loadAllowlistedTestPhone(
  env: Record<string, string | undefined> = process.env,
  fs?: DevEnvFs,
): string | undefined {
  if (!env.VOICE_HARNESS_DEV_ENV_FILE?.trim()) return undefined;
  try {
    readDevEnvFile(env, fs);
  } catch {
    return undefined;
  }
  const values = peekDevEnvValues(ENV_NAMES, env, fs);
  for (const key of ENV_NAMES) {
    const phone = values[key]?.trim();
    if (phone && /^\+155501\d{2}$/.test(phone)) return phone;
  }
  return undefined;
}

/** Refuses any destination that is not exactly the allowlisted test number. */
export function assertTestPhoneOnly(destination: string, allowlisted: string): void {
  const norm = (s: string) => s.replace(/\D/g, "");
  if (norm(destination) !== norm(allowlisted)) throw new Error("test_phone_not_allowlisted");
}
