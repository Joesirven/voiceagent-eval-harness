/** The smallest tree the validator accepts, for mutation tests. Synthetic wording. */

import type { DecisionTreeData, TreeAnswer } from "../../src/decision-tree/types.js";

const gate = (question: string, minConfidence = 0.75) => ({ codeRules: ["the caller's own words back it"], question, minConfidence });
const unclear: TreeAnswer = { answer: "unclear", minConfidence: 0 };

export function minimalTree(): DecisionTreeData {
  return {
    id: "fixture",
    version: "0",
    start: "entry.inbound",
    starts: { inbound: "entry.inbound", outbound: "entry.outbound" },
    maxClarifications: 2,
    escalation: { say: "Let me get a person to help.", disposition: "handed_off" },
    repeatRule: { say: "Understood, I will let you go. Thanks for your time.", disposition: "soft_declined" },
    interrupts: {
      question: "Is the caller interrupting the flow?",
      clarify: "Sorry, could you say that again?",
      answers: [
        { answer: "none", minConfidence: 0 },
        unclear,
        { answer: "asks_if_ai", meaning: "Asks whether this is a robot or an AI.", minConfidence: 0.7, resume: true, say: "Yes, I am an AI assistant for the agency." },
        {
          answer: "asks_for_person",
          meaning: "Asks to speak with a person now.",
          minConfidence: 0.75,
          next: "safety.person",
        },
      ],
    },
    dispositions: [
      { name: "booked", label: "Booked", durable: false, meaning: "A producer time was booked.", crmEquivalent: "callback" },
      { name: "not_interested", label: "Not interested", durable: true, meaning: "Refused in their own words.", crmEquivalent: "not_interested" },
      { name: "handed_off", label: "Handed to a person", durable: false, meaning: "Transferred.", crmEquivalent: "talked" },
      { name: "soft_declined", label: "Declined twice", durable: false, meaning: "Same brush-off twice.", crmEquivalent: "talked" },
    ],
    nodes: [
      {
        id: "entry.inbound",
        label: "Why they called",
        area: "entry",
        situation: "A lead calls the agency line.",
        agentGoal: "Learn why they called.",
        clarify: "Sorry, what can I help you with?",
        sources: ["context/17 section 17.5"],
        decision: {
          question: "Why is the caller calling?",
          answers: [
            unclear,
            { answer: "returning_missed_calls", meaning: "Says they had missed calls from this number.", minConfidence: 0.7, next: "booking.offer" },
            {
              answer: "not_interested",
              meaning: "Refuses in their own words.",
              minConfidence: 0.85,
              disposition: "not_interested",
              say: "Understood. Thanks for calling back.",
              onBlocked: { say: "Sorry, did you want me to stop calling?" },
              judge: gate("Did the caller refuse in their own words?", 0.85),
            },
          ],
        },
      },
      {
        id: "entry.outbound",
        label: "Who answered",
        area: "entry",
        situation: "A person answers an outbound call.",
        agentGoal: "Confirm who answered.",
        agentLines: [{ line: "Hi, is this {firstName}?", direction: "outbound" }],
        clarify: "Sorry, am I speaking with {firstName}?",
        sources: ["context/03 section 3.3"],
        decision: {
          question: "Is the person on the line the lead?",
          answers: [
            unclear,
            { answer: "yes", meaning: "Confirms they are the lead.", minConfidence: 0.7, next: "booking.offer" },
            { answer: "no", meaning: "Says they are someone else.", minConfidence: 0.7, next: "safety.person" },
          ],
        },
      },
      {
        id: "booking.offer",
        label: "Offer a time",
        area: "booking",
        situation: "The caller is open to a meeting.",
        agentGoal: "Book a time with the producer.",
        agentLines: [{ line: "Could the producer come by Tuesday at ten?" }],
        clarify: "Would Tuesday at ten work?",
        sources: ["context/16 section 16.1"],
        decision: {
          question: "Did the caller accept a time?",
          answers: [
            unclear,
            {
              answer: "accepts_time",
              meaning: "Names or accepts a day and time.",
              minConfidence: 0.75,
              extract: { as: "slot", with: "time" },
              action: { type: "book", from: "slot" },
              disposition: "booked",
              say: "Booked for {slotWords}.",
              onBlocked: { say: "Let me check that time again." },
              judge: gate("Did the caller agree to this time in their own words?"),
            },
            { answer: "declines", meaning: "Does not want a meeting.", minConfidence: 0.7, next: "safety.person" },
          ],
        },
      },
      {
        id: "safety.person",
        label: "Bring in a person",
        area: "safety",
        situation: "The caller wants a person.",
        agentGoal: "Transfer to a person.",
        clarify: "Would you like me to connect you to a person?",
        sources: ["context/17 section 17.3"],
        decision: {
          question: "Does the caller want to be connected now?",
          answers: [
            unclear,
            {
              answer: "yes",
              meaning: "Agrees to be connected.",
              minConfidence: 0.75,
              action: { type: "transfer", reason: "caller_requested" },
              disposition: "handed_off",
              onBlocked: { say: "Nobody is free right now. Can I take a message?" },
              judge: gate("Did the caller ask for a person?"),
            },
            {
              answer: "no",
              meaning: "Declines.",
              minConfidence: 0.7,
              disposition: "soft_declined",
              onBlocked: { say: "Sorry, did you want a person?" },
              judge: gate("Did the caller decline?"),
            },
          ],
        },
      },
    ],
  };
}
