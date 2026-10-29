import { ChevronRightIcon, FlagIcon } from "lucide-react";
import { useMemo } from "react";
import * as core from "../../../src/server/live-view-core.js";
import type { TreeJson, TreeNode } from "../../../src/server/live-view-core.js";
import { foldTree, words } from "@/lib/tree";
import { cn } from "@/lib/utils";

const MAX_NEXT = 6;
const MAX_AFTER = 3;

function Next({ tree, node, taken, depth }: { tree: TreeJson; node: TreeNode; taken: string | null; depth: number }) {
  const max = depth === 0 ? MAX_NEXT : MAX_AFTER;
  const all = node.edges.filter((e) => e.to);
  const edges = all.slice(0, max);
  if (!edges.length) return null;
  return (
    <ul className={cn("space-y-1", depth > 0 && "ml-4 border-l pl-3")}>
      {edges.map((e, i) => {
        const target = core.findTreeNode(tree, e.to);
        const ending = target?.disposition;
        return (
          <li key={i} className="text-xs">
            <div className={cn("flex items-baseline gap-1.5", e.answer === taken && "font-semibold text-primary")}>
              <ChevronRightIcon className="size-3 shrink-0 self-center text-muted-foreground" />
              <span className="text-muted-foreground">If they say</span>{" "}<span>{words(e.answer)}</span>{" "}
              <span className="text-muted-foreground">then</span>{" "}
              <span className={cn(ending && "inline-flex items-center gap-1")}>
                {ending && <FlagIcon className="size-3" />}{ending ? `end: ${words(ending)}` : target?.label ?? core.edgeDestination(tree, e)}
              </span>
            </div>
            {depth < 1 && target && !ending && <Next tree={tree} node={target} taken={null} depth={depth + 1} />}
          </li>
        );
      })}
      {all.length > max && <li className="ml-4 text-[11px] text-muted-foreground">and {all.length - max} more</li>}
    </ul>
  );
}

/**
 * The tree in plain words for a salesperson: where the call is now, the question being asked, and the next
 * two steps. No node ids; follow-up ("_more") nodes are folded into their parent. The full map is one click away.
 */
export function TreeFocus({ tree, currentId, path, takenAnswer }: {
  tree: TreeJson | null; currentId: string | null; path: string[]; takenAnswer: string | null;
}) {
  const folded = useMemo(() => (tree ? foldTree(tree) : null), [tree]);
  if (!tree || !folded) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const id = folded.resolve(currentId) ?? folded.resolve(tree.start);
  const node = core.findTreeNode(folded.tree, id);
  if (!node) return <p className="text-sm text-muted-foreground">Waiting for the call to start…</p>;
  const crumbs = path.filter((p, i) => p !== path[i - 1]);
  return (
    <div className="space-y-2 text-sm" id="treeFocus">
      {crumbs.length > 0 && <div className="flex flex-wrap gap-x-1 text-[11px] text-muted-foreground">{crumbs.map((c, i) => <span key={i}>{c}{i < crumbs.length - 1 ? " ›" : ""}</span>)}</div>}
      <div className="rounded-md border border-primary/40 bg-accent/40 p-2">
        <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{currentId ? "Now" : "Starts with"}</div>
        <div className="font-semibold">{node.label}</div>
        {node.question && <p className="mt-0.5 text-xs text-muted-foreground">{node.question}</p>}
      </div>
      <Next tree={folded.tree} node={node} taken={takenAnswer} depth={0} />
    </div>
  );
}
