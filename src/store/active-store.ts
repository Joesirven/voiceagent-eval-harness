/** The built-in lead store. External CRM adapters implement LeadStore. */

import { mockLeadStore, type LeadStore } from "./lead-store-seam.js";

export function getActiveLeadStore(): LeadStore {
  return mockLeadStore;
}
