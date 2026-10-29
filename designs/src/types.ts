/**
 * What every design receives. The tree is the real one (src/decision-tree/full-tree.json);
 * the helpers in lab/src/stories (plain-words.ts, walk.ts, lights.ts) turn node ids and
 * answers into plain words, fold the "_more" follow-up nodes and colour answers.
 */
import type { ReactElement } from "react";
import type { LabTree } from "../../lab/src/stories/walk.js";

export type { LabTree };

export interface DesignProps {
  tree: LabTree;
}

export interface DesignEntry {
  /** Shown in the picker, for example "Call script". */
  name: string;
  /** One sentence: the idea and who it suits. */
  idea: string;
  Component: (props: DesignProps) => ReactElement;
}
