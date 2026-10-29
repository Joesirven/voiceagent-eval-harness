/**
 * Example calls for the fictional Northwind Insurance Agency renewal tree.
 * Every turn names a real node and answer.
 */
import type { ExampleCall } from "./walk.js";

export const EXAMPLE_CALLS: ExampleCall[] = [
  {
    id: "books-a-producer-call",
    title: "A business owner books a producer call",
    summary: "The caller consents, gives two quote facts, and confirms a time.",
    direction: "inbound",
    firstName: "Maria",
    slotWords: "Thursday at ten in the morning",
    ending: "booked",
    turns: [
      { at: "entry.greeting", caller: "Yes, you may continue.", answer: "consents", why: "The caller consents to the renewal questions." },
      { at: "identity.confirm", caller: "Yes, I handle the renewal.", answer: "right_person", why: "The caller handles the renewal." },
      { at: "discovery.employees", caller: "We have six employees.", answer: "gave_count", why: "The caller gives an employee count." },
      { at: "discovery.payroll", caller: "Annual payroll is about four hundred thousand.", answer: "gave_payroll", why: "The caller gives annual payroll." },
      { at: "booking.offer", caller: "Yes, I would like a call.", answer: "accepts", why: "The caller accepts a producer call." },
      { at: "booking.time", caller: "Thursday at ten in the morning.", answer: "gave_time", why: "The caller gives a day and time." },
      { at: "booking.confirm", caller: "Yes, book it.", answer: "confirms", why: "The caller confirms the booking." },
    ],
  },
  {
    id: "declines-at-entry",
    title: "A caller declines to continue",
    summary: "The caller does not consent, so the call ends without another question.",
    direction: "inbound",
    firstName: "Tom",
    ending: "completed",
    turns: [
      { at: "entry.greeting", caller: "No, I do not want to continue.", answer: "declines", why: "The caller declines the renewal conversation." },
    ],
  },
  {
    id: "not-interested",
    title: "A caller is not interested",
    summary: "The right contact gives a durable refusal.",
    direction: "inbound",
    firstName: "Priya",
    ending: "not_interested",
    turns: [
      { at: "entry.greeting", caller: "Yes, go ahead.", answer: "consents", why: "The caller consents." },
      { at: "identity.confirm", caller: "I handle it, but I am not interested.", answer: "not_interested", why: "The caller clearly declines the renewal discussion." },
    ],
  },
];
