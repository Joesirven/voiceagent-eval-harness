import { describe, expect, it } from "vitest";
import { layoutTree } from "../../src/server/live-view-core.js";
import {
  CALLBACK_ANSWER,
  DecisionTreeError,
  INTERRUPTS_NODE_ID,
  loadDecisionTree,
  toEngineTree,
  toChoiceQuestion,
  toJudgeQuestion,
  toLiveTreeJson,
  treeProblems,
  validateDecisionTree,
  type DecisionTreeData,
} from "../../src/decision-tree/index.js";
import { FULL_TREE_FILE } from "../../src/decision/tree-source.js";
import { minimalTree } from "./fixture.js";

function mutate(change: (t: DecisionTreeData) => void): string[] {
  const t = minimalTree();
  change(t);
  return treeProblems(t);
}
const node = (t: DecisionTreeData, id: string) => t.nodes.find((n) => n.id === id)!;
const answer = (t: DecisionTreeData, id: string, name: string) => node(t, id).decision!.answers.find((a) => a.answer === name)!;

describe("the shipped decision tree", () => {
  const tree = loadDecisionTree();

  it("passes every validator rule", () => {
    expect(treeProblems(tree)).toEqual([]);
  });

  it("enters an inbound call able to recognize a lead returning the two unanswered calls", () => {
    const entry = tree.byId.get(tree.starts.inbound)!;
    expect(entry.decision!.answers.map((a) => a.answer)).toContain(CALLBACK_ANSWER);
  });

  it("gates every destructive action and every ending, with durable endings at 0.85 or more", () => {
    const durable = new Set(tree.dispositions.filter((d) => d.durable).map((d) => d.name));
    const answers = [...tree.nodes.flatMap((n) => n.decision?.answers ?? []), ...tree.interrupts.answers];
    for (const a of answers.filter((x) => x.action || x.disposition)) {
      expect(a.judge, a.answer).toBeDefined();
      if (a.disposition && durable.has(a.disposition)) expect(a.minConfidence).toBeGreaterThanOrEqual(0.85);
    }
  });

  it("projects into the engine's tree for both directions", () => {
    for (const direction of ["inbound", "outbound"] as const) {
      const engine = toEngineTree(tree, direction);
      expect(engine.nodes[engine.start]).toBeDefined();
      for (const n of Object.values(engine.nodes)) {
        for (const a of n.decision?.answers ?? []) {
          if (a.next) expect(engine.nodes[a.next], `${n.id}.${a.answer}`).toBeDefined();
          if (a.disposition) expect(engine.dispositions.map((d) => d.name)).toContain(a.disposition);
        }
      }
    }
    expect(toEngineTree(tree, "outbound").start).toBe(tree.starts.outbound);
  });

  it("projects into the live view's tree and lays out", () => {
    const view = toLiveTreeJson(tree);
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const n of view.nodes) for (const e of n.edges) if (e.to !== null) expect(ids.has(e.to), `${n.id} -> ${e.to}`).toBe(true);
    expect(ids.has(INTERRUPTS_NODE_ID)).toBe(true);
    const { placed, columns } = layoutTree(view);
    expect(placed).toHaveLength(view.nodes.length);
    expect(columns).toBeGreaterThan(1);
  });
});

describe("the full tree (src/decision-tree/full-tree.json)", () => {
  const tree = loadDecisionTree(FULL_TREE_FILE);

  it("gives every interrupt answer a meaning, \"none\" and \"unclear\" included", () => {
    for (const a of tree.interrupts.answers) expect(a.meaning?.trim(), `interrupts.${a.answer}`).toBeTruthy();
    expect(tree.interrupts.answers.find((a) => a.answer === "none")!.meaning).toMatch(/answers or acknowledges the current question/i);
  });

  it("uses the fictional Northwind Insurance Agency renewal example", () => {
    expect(tree.id).toBe("northwind-renewal");
    expect(tree.nodes).toHaveLength(9);
    expect(tree.byId.get("entry.greeting")!.agentLines![0]!.line).toMatch(/Northwind Insurance Agency.*policy renewal/i);
    expect(tree.byId.get("identity.confirm")!.agentLines![0]!.line).toMatch(/Riverside Plumbing/);
  });

  it("collects employee count and payroll before it offers a producer call", () => {
    const employees = tree.byId.get("discovery.employees")!;
    const payroll = tree.byId.get("discovery.payroll")!;
    expect(employees.decision!.answers.find((a) => a.answer === "gave_count")!.action).toMatchObject({ type: "save_quote_field", field: "employee_count" });
    expect(payroll.decision!.answers.find((a) => a.answer === "gave_payroll")!.action).toMatchObject({ type: "save_quote_field", field: "payroll" });
    expect(payroll.decision!.answers.find((a) => a.answer === "gave_payroll")!.next).toBe("booking.offer");
  });

  it("books only after a time read-back and a judged confirmation", () => {
    const named = tree.byId.get("booking.time")!.decision!.answers.find((a) => a.answer === "gave_time")!;
    const confirmed = tree.byId.get("booking.confirm")!.decision!.answers.find((a) => a.answer === "confirms")!;
    expect(named.extract).toEqual({ as: "slot", with: "time" });
    expect(confirmed.action).toEqual({ type: "book", from: "slot" });
    expect(confirmed.disposition).toBe("booked");
    expect(confirmed.judge).toBeDefined();
  });

  it("handles a clear refusal and confirms a stop request", () => {
    expect(tree.byId.get("booking.offer")!.decision!.answers.find((a) => a.answer === "not_interested")!.disposition).toBe("not_interested");
    expect(tree.interrupts.answers.find((a) => a.answer === "asks_to_stop")!.next).toBe("compliance.stop");
    expect(tree.byId.get("compliance.stop")!.decision!.answers.find((a) => a.answer === "confirms")!.disposition).toBe("do_not_contact");
  });
});

describe("typed questions for the decision module", () => {
  const tree = validateDecisionTree(minimalTree());

  it("turns a node into a choice question with one criterion per answer", () => {
    const q = toChoiceQuestion(tree.byId.get("entry.outbound")!);
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual(["unclear", "yes", "no"]);
    expect(q.criteria.yes).toBe("Confirms they are the lead.");
    expect(q.criteria.unclear).toMatch(/not clear enough/);
  });

  it("turns the interrupts into a choice question", () => {
    expect(Object.keys(toChoiceQuestion(tree.interrupts).criteria)).toContain("none");
  });

  it("turns a judge into a true or false question and refuses an ungated answer", () => {
    const gated = tree.byId.get("booking.offer")!.decision!.answers.find((a) => a.answer === "accepts_time")!;
    expect(toJudgeQuestion(gated)).toMatchObject({ type: "noul", instructions: gated.judge!.question });
    const open = tree.byId.get("entry.outbound")!.decision!.answers.find((a) => a.answer === "yes")!;
    expect(() => toJudgeQuestion(open)).toThrow(/not judge-gated/);
  });

  it("asks every node of the shipped tree as a closed question", () => {
    const shipped = loadDecisionTree();
    for (const n of shipped.nodes.filter((x) => x.decision)) {
      expect(Object.keys(toChoiceQuestion(n).criteria)).toEqual(n.decision!.answers.map((a) => a.answer));
    }
  });
});

describe("the validator", () => {
  it("accepts the minimal fixture and indexes it", () => {
    expect(treeProblems(minimalTree())).toEqual([]);
    expect(validateDecisionTree(minimalTree()).byId.get("booking.offer")?.label).toBe("Offer a time");
  });

  it("throws listing every problem", () => {
    const t = minimalTree();
    t.nodes.push({ ...t.nodes[0]!, id: "entry.inbound" });
    expect(() => validateDecisionTree(t)).toThrow(DecisionTreeError);
  });

  it("requires an unclear answer on every question", () => {
    expect(mutate((t) => node(t, "booking.offer").decision!.answers.shift())).toContain('booking.offer needs an "unclear" answer');
  });

  it("refuses a bar of 1 or below 0.6", () => {
    expect(mutate((t) => (answer(t, "entry.outbound", "yes").minConfidence = 1)).join()).toMatch(/entry\.outbound\.yes needs a minConfidence/);
    expect(mutate((t) => (answer(t, "entry.outbound", "yes").minConfidence = 0.4)).join()).toMatch(/entry\.outbound\.yes needs a minConfidence/);
  });

  it("requires a bar of at least 0.85 on a durable ending, in the answer and in its judge", () => {
    const problems = mutate((t) => {
      const a = answer(t, "entry.inbound", "not_interested");
      a.minConfidence = 0.8;
      a.judge!.minConfidence = 0.8;
    });
    expect(problems.join()).toMatch(/ends durably \(not_interested\) and needs minConfidence/);
    expect(problems.join()).toMatch(/judge ends durably/);
  });

  it("requires a judge and a refusal line on every gated answer", () => {
    const problems = mutate((t) => {
      const a = answer(t, "safety.person", "yes");
      delete a.judge;
      delete a.onBlocked;
    });
    expect(problems).toContain("safety.person.yes is judge-gated and needs onBlocked.say");
    expect(problems.join()).toMatch(/safety\.person\.yes is judge-gated and needs a judge/);
  });

  it("books only from a time the caller said", () => {
    const problems = mutate((t) => {
      const a = answer(t, "booking.offer", "accepts_time");
      a.extract = { as: "slot", with: "caller_line" };
    });
    expect(problems.join()).toMatch(/books from \{slot\}, which no time extract sets/);
  });

  it("finds dangling links, orphans and dead ends", () => {
    expect(mutate((t) => (answer(t, "entry.outbound", "yes").next = "booking.nowhere")).join()).toMatch(/points at missing node booking\.nowhere/);
    const orphan = mutate((t) => t.nodes.push({ ...node(t, "safety.person"), id: "safety.orphan" }));
    expect(orphan).toContain("safety.orphan cannot be reached from either start or an interrupt");
  });

  it("requires the callback entry", () => {
    expect(mutate((t) => (answer(t, "entry.inbound", CALLBACK_ANSWER).answer = "callback")).join()).toMatch(/needs a "returning_missed_calls" answer/);
  });

  it("caps answers per question", () => {
    const problems = mutate((t) => {
      const answers = node(t, "entry.outbound").decision!.answers;
      for (let i = 0; i < 6; i++) answers.push({ answer: `extra_${i}`, meaning: "Another answer.", minConfidence: 0.7, next: "booking.offer" });
    });
    expect(problems.join()).toMatch(/entry\.outbound has 9 answers/);
  });

  it("refuses abbreviations, prices and em-dashes in spoken lines, and unknown variables", () => {
    const problems = mutate((t) => {
      node(t, "booking.offer").agentLines = [{ line: "Your GL could be $200 cheaper — {plan}." }];
    });
    expect(problems.join()).toMatch(/uses the abbreviation "GL"/);
    expect(problems.join()).toMatch(/states a price/);
    expect(problems.join()).toMatch(/em-dash/);
    expect(problems.join()).toMatch(/uses \{plan\}, which nothing sets/);
  });

  it("requires a repeat key on objection nodes and a non-durable repeat ending", () => {
    expect(mutate((t) => (node(t, "booking.offer").area = "objection")).join()).toMatch(/booking\.offer is an objection and needs a repeatKey/);
    expect(mutate((t) => (t.repeatRule.disposition = "not_interested")).join()).toMatch(/repeatRule must end with a non-durable disposition/);
  });

  it("lets only interrupts resume the current node, and only after saying something", () => {
    expect(mutate((t) => (answer(t, "entry.outbound", "yes").resume = true)).join()).toMatch(/entry\.outbound\.yes uses resume/);
    expect(
      mutate((t) => {
        const a = t.interrupts.answers.find((x) => x.answer === "asks_if_ai")!;
        delete a.say;
      }).join(),
    ).toMatch(/needs a line to say first/);
  });

  it("checks the details a node collects: known values, spoken-line rules, and another node to move on to", () => {
    const collecting = (change: (c: NonNullable<ReturnType<typeof node>["collects"]>) => void) =>
      mutate((t) => {
        const n = node(t, "entry.outbound");
        n.collects = { values: ["callerName", "businessName"], lines: { businessName: "Thanks, {callerName}. And the business?" }, then: "booking.offer" };
        change(n.collects);
      });
    expect(collecting(() => {})).toEqual([]);
    expect(collecting((c) => ((c.values as string[]).push("shoeSize"))).join()).toMatch(/collects has unknown value shoeSize/);
    expect(collecting((c) => (c.lines!.businessName = "Thanks \u2014 and the business?")).join()).toMatch(/collects\.lines\.businessName uses an em-dash/);
    expect(collecting((c) => (c.lines!.businessName = "And the business, {plan}?")).join()).toMatch(/uses \{plan\}, which nothing sets/);
    expect(collecting((c) => (c.then = "entry.outbound")).join()).toMatch(/collects moves on to itself/);
    expect(collecting((c) => (c.then = "nowhere.at_all")).join()).toMatch(/collects\.then points at missing node/);
    expect(
      mutate((t) => {
        const n = node(t, "safety.person");
        n.collects = { values: ["callerName"], then: "booking.offer" };
        delete n.decision;
      }).join(),
    ).toMatch(/collects caller details and needs a question/);
  });

  it("lets only node answers return to where the call was, with a next node to fall back on", () => {
    expect(mutate((t) => (answer(t, "entry.outbound", "yes").returnToOrigin = true))).toEqual([]);
    expect(mutate((t) => (t.interrupts.answers.find((x) => x.answer === "asks_for_person")!.returnToOrigin = true)).join()).toMatch(/uses returnToOrigin, which only node answers may use/);
    expect(mutate((t) => (answer(t, "entry.inbound", "not_interested").returnToOrigin = true)).join()).toMatch(/needs a next node to fall back on/);
  });

  it("reports a disposition nothing uses", () => {
    expect(mutate((t) => t.dispositions.push({ name: "spare", label: "Spare", durable: false, meaning: "Unused.", crmEquivalent: "none: test" }))).toContain(
      "disposition spare is never used",
    );
  });
});
