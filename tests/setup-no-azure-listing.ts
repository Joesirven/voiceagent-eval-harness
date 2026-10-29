import { setDefaultAzureCatalogDeps } from "../src/modules/azure-catalog.js";

// No test reaches the real Azure deployment listing, even with VOICE_HARNESS_DEV_ENV_FILE exported:
// the catalog's default fetch refuses, so it falls back to the settings names. Tests that
// exercise the listing pass their own fake fetch.
setDefaultAzureCatalogDeps({
  fetch: (async () => {
    throw new Error("network_disabled_in_tests");
  }) as typeof fetch,
});
