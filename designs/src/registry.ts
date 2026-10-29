/** The ten designs, in picker order. Each design lives in its own file under ./designs. */
import type { DesignEntry } from "./types.js";
import Design01, { idea as idea1, name as name1 } from "./designs/01-call-script.js";
import Design02, { idea as idea2, name as name2 } from "./designs/02-step-by-step-wizard.js";
import Design03, { idea as idea3, name as name3 } from "./designs/03-checklist-by-stage.js";
import Design04, { idea as idea4, name as name4 } from "./designs/04-swimlane-by-stage.js";
import Design05, { idea as idea5, name as name5 } from "./designs/05-next-best-line.js";
import Design06, { idea as idea6, name as name6 } from "./designs/06-traffic-light-map.js";
import Design07, { idea as idea7, name as name7 } from "./designs/07-collapsible-outline.js";
import Design08, { idea as idea8, name as name8 } from "./designs/08-phrase-book.js";
import Design09, { idea as idea9, name as name9 } from "./designs/09-how-calls-end.js";
import Design10, { idea as idea10, name as name10 } from "./designs/10-main-road-flowchart.js";

export const DESIGNS: DesignEntry[] = [
  { name: name1, idea: idea1, Component: Design01 },
  { name: name2, idea: idea2, Component: Design02 },
  { name: name3, idea: idea3, Component: Design03 },
  { name: name4, idea: idea4, Component: Design04 },
  { name: name5, idea: idea5, Component: Design05 },
  { name: name6, idea: idea6, Component: Design06 },
  { name: name7, idea: idea7, Component: Design07 },
  { name: name8, idea: idea8, Component: Design08 },
  { name: name9, idea: idea9, Component: Design09 },
  { name: name10, idea: idea10, Component: Design10 },
];
