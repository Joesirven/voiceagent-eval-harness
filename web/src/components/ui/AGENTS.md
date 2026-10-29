# AGENTS.md: `web/src/components/ui/`

Reusable interface building blocks for the harness web app. Each file wraps a Radix primitive or a charting or animation library in a styled component, tagged with data-slot attributes. Most files are small wrappers that pages import and compose.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../../AGENTS.md).

## Contents

- `accordion.tsx`: Expandable section list built on Radix accordion, with a rotating chevron trigger.
- `alert.tsx`: Alert box with default and destructive variants, using role alert.
- `badge.tsx`: Small pill label with variants (default, secondary, destructive, outline, ghost, link); can render as its child.
- `button.tsx`: Button with variant and size options via class-variance-authority; can render as its child.
- `card.tsx`: Card container with header, title, description, action, content and footer parts.
- `chart.test.tsx`: Tests for ChartStyle: colour variables written as plain text, and nothing rendered without colours.
- `chart.tsx`: Chart wrapper around Recharts: config-driven colours per light and dark theme, tooltip and legend parts.
- `collapsible.tsx`: Radix collapsible wrapper exporting Collapsible, CollapsibleTrigger and CollapsibleContent.
- `dialog.tsx`: Modal dialog built on Radix dialog, with overlay, close button and portal parts.
- `label.tsx`: Form field label built on Radix label, with disabled-state styling.
- `live-waveform.tsx`: Draws a loudness waveform from a level the caller measures; it never opens a microphone itself.
- `orb.tsx`: Animated three-dimensional orb (React Three Fiber) showing agent states: idle, listening, thinking, talking, working.
- `resizable.tsx`: Resizable panel group, panel and drag handle built on react-resizable-panels.
- `scroll-area.tsx`: Scrollable area with a styled vertical or horizontal scrollbar, built on Radix scroll area.
- `select.tsx`: Dropdown select built on Radix select, with trigger sizes, scroll buttons and item parts.
- `separator.tsx`: Horizontal or vertical divider line built on Radix separator.
- `sheet.tsx`: Side panel (sheet) built on the Radix dialog primitive, with overlay, portal and close parts.
- `sonner.tsx`: Toast notification container (Sonner) with fixed light theme and custom icons.
- `switch.tsx`: On and off switch built on Radix switch, with default and small sizes.
- `table.tsx`: Table with container, header, body, footer, row, cell and caption parts.
- `tabs.tsx`: Tabs built on Radix tabs, with default and line list variants and horizontal or vertical orientation.
- `toggle-group.tsx`: Group of toggle buttons sharing variant and size from context, built on Radix toggle group.
- `toggle.tsx`: Two-state toggle button built on Radix toggle, with default and outline variants and three sizes.
- `tooltip.tsx`: Hover tooltip built on Radix tooltip, with a provider, trigger and portaled content.
- `trace.tsx`: Collapsible trace list for showing steps, with lines that can be running, pending or in error.

## Rules

- chart.test.tsx runs in jsdom (a browser-like test environment) and uses Testing Library helpers.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
