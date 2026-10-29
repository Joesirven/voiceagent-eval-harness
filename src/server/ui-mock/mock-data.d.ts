export const leads: Array<Record<string, any>>;
export const voiceModules: string[];
export const decisionModules: string[];
export const promptSetups: string[];
export const tree: { start: string; nodes: Array<Record<string, any>>; dispositions: Record<string, string> };
export const script: Array<{ ms: number; type: string; speakMs?: number; data: Record<string, any> }>;
export const summary: Record<string, any>;
