export * from "./contract.js";
export * from "./session.js";
export * from "./own-infrastructure.js";
export * from "./pipecat.js";

import { OrchestrationError, type DecisionRuntime, type OrchestrationId, type OrchestrationModule, type SessionConfig } from "./contract.js";
import { OrchestrationSession, type SessionOptions } from "./session.js";

/** Selection affects future sessions only. No coupling to the voice module registry. */
export class OrchestrationRegistry {
  private modules = new Map<OrchestrationId, OrchestrationModule>();
  private selectedId: OrchestrationId;
  constructor(modules: OrchestrationModule[], selectedId: OrchestrationId = "own-infrastructure") {
    for (const module of modules) {
      if (this.modules.has(module.id)) throw new OrchestrationError("invalid_config");
      this.modules.set(module.id, module);
    }
    this.selectedId = selectedId;
    this.get(selectedId);
  }
  private get(id: OrchestrationId): OrchestrationModule {
    const module = this.modules.get(id);
    if (!module) throw new OrchestrationError("unavailable");
    return module;
  }
  list() { return [...this.modules.values()].map((module) => module.capabilities()); }
  select(id: OrchestrationId) { this.get(id); this.selectedId = id; }
  selected() { return this.selectedId; }
  createSession(config: Omit<SessionConfig, "orchestrationId"> & { orchestrationId?: OrchestrationId }, decision: DecisionRuntime, options: SessionOptions) {
    const id = config.orchestrationId ?? this.selectedId;
    return new OrchestrationSession(this.get(id), { ...config, orchestrationId: id }, decision, options);
  }
}
