/** `pnpm records:purge`: deletes every call and text record on disk. */
import { recordStore } from "../src/trace/index.js";

const dir = recordStore.dir;
const removed = recordStore.purge();
console.log(`Removed ${removed} record file(s) from ${dir}`);
