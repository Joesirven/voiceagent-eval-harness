# Voice Agent Evaluation Harness

A public test bench for phone voice agents. It runs simulated and live calls, applies calling rules, records traces, and grades each call. The included examples use the fictional Northwind Insurance Agency.

## What is included

| Path | Purpose |
| --- | --- |
| `src/` | Harness server, call orchestration, decision modules, judges, and the mock lead store. |
| `web/` | Voice Agent Console for calls, simulations, traces, and grading. |
| `tests/` | Unit, integration, simulation, and live-path tests. |
| `docs/` | Architecture, interfaces, call-flow, and evaluation notes. |
| `supabase/harness/` | Numbered migrations for the harness database. |
| `db/` | Standalone table definitions for harness data. |
| `lab/` and `designs/` | Helpers and previews for decision-tree interface designs. |

## Start the harness

Use Node.js and pnpm.

```sh
pnpm install
pnpm dev
```

The development server uses port 4310 by default. Set `PORT` to use another local port.

Run all build, type, and test checks before you commit:

```sh
pnpm check
```

## Configuration

Configure the harness with environment variables. Do not commit credentials or environment files. The server configuration in `src/config.ts` documents the supported variables and safe defaults.

Live voice paths can require model, telephony, speech-to-text, text-to-speech, or database credentials. Simulated calls and the mock lead store do not require a customer relationship management system.

## Lead data and customer relationship management systems

The mock lead store is the default. Its fictional records use Northwind Insurance Agency, Pat Lee, Dana Reyes, Chris Morgan, Riverside Plumbing, Oak Street Electric, and Summit Roofing.

`LeadStore` is the server-side interface for lead search, lead context, and approved updates. Implement that interface to connect a customer relationship management system. Keep credentials on the server. Keep customer data out of browser bundles, fixtures, logs, and repository files.

The harness does not include an adapter for a real agency application. A custom adapter must preserve the safety rules in the `LeadStore` interface and must make its write policy explicit.

## License

This project uses the [MIT License](LICENSE).
