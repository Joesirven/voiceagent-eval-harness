import { useDefaultLayout } from "react-resizable-panels";

/** Panel sizes are remembered between visits in the browser's local storage. */
export function useLayout(id: string) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id, storage: localStorage });
  return { defaultLayout, onLayoutChanged };
}
