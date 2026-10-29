import { describe, expect, it, vi } from "vitest";
import { buildPreviewBody, buildSetupBody, debounce, draftFromSetup, errorWording, isDirty, isKebabCase, resetOverride, setOverride, toggleLayer } from "../../console-standard/web/src/prompt/logic.js";

const setup = { id: "a", label: "A", description: "d", shipped: false, layers: ["floor", "role", "disclosure"], personalityId: "warm", overrides: { role: "R" } };
const order = ["floor", "role", "style", "disclosure"];

describe("error wording", () => {
  it("maps known codes to sentences", () => {
    expect(errorWording("disclosure_locked")).toMatch(/cannot be edited/);
    expect(errorWording("disclosure_missing")).toMatch(/opening script/);
    expect(errorWording("setup_is_shipped")).toMatch(/Save as new/);
  });
  it("falls back in plain words", () => {
    expect(errorWording("network")).toMatch(/could not be reached/);
    expect(errorWording("odd_thing")).toContain("odd thing");
    expect(errorWording(undefined, 500)).toMatch(/server had a problem/);
  });
});

describe("draft handling", () => {
  it("detects changes and not-changes", () => {
    const d = draftFromSetup(setup);
    expect(isDirty(d, setup)).toBe(false);
    expect(isDirty({ ...d, personalityId: "x" }, setup)).toBe(true);
    expect(isDirty(setOverride(d, "role", "other", "def"), setup)).toBe(true);
  });
  it("override equal to default is removed; reset removes it", () => {
    const d = draftFromSetup(setup);
    expect(setOverride(d, "role", "def", "def").overrides).toEqual({});
    expect(resetOverride(d, "role").overrides).toEqual({});
    expect(isDirty(resetOverride(d, "role"), setup)).toBe(true);
  });
  it("disclosure cannot be overridden or turned off", () => {
    const d = draftFromSetup(setup);
    expect(setOverride(d, "disclosure", "x", "y")).toBe(d);
    expect(toggleLayer(d, "disclosure", false, order)).toBe(d);
    expect(toggleLayer(d, "style", true, order).layers).toEqual(["floor", "role", "style", "disclosure"]);
  });
  it("checks kebab-case ids", () => {
    expect(isKebabCase("friendly-short")).toBe(true);
    expect(isKebabCase("Bad_Id")).toBe(false);
  });
});

describe("request bodies", () => {
  it("never puts the disclosure in overrides and always in layers", () => {
    const d = { ...draftFromSetup(setup), layers: ["role"], overrides: { role: "R", disclosure: "evil" } };
    const body = buildSetupBody(d);
    expect(body.overrides).toEqual({ role: "R" });
    expect(body.layers).toContain("disclosure");
    expect("notes" in body).toBe(false);
  });
  it("preview body defaults the lead", () => {
    expect(buildPreviewBody(draftFromSetup(setup), " ", "outbound")).toMatchObject({ lead: "lead-1", direction: "outbound" });
  });
});

describe("debounce", () => {
  it("fires once after the quiet period and can be cancelled", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 600);
    d(1); d(2); vi.advanceTimersByTime(599); expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fn).toHaveBeenCalledTimes(1); expect(fn).toHaveBeenCalledWith(2);
    d(3); d.cancel(); vi.advanceTimersByTime(1000); expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
