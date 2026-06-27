export type Decision = "allow" | "deny" | "escalate" | "modify";

export interface ScenarioStep {
  tool: string;
  payload?: Record<string, unknown>;
  expect?: Decision;
  // Optional per-step agent override
  agent_id?: string;
}

export interface Scenario {
  name: string;
  agent_id: string;
  steps: ScenarioStep[];
}

export interface CIConfig {
  api_url?: string;
  scenarios: Scenario[];
}

export interface StepResult {
  scenario: string;
  step: number;
  tool: string;
  expected: Decision | null;
  decision: Decision;
  risk_score: number;
  reason: string;
  passed: boolean;
  duration_ms: number;
}

export interface ScenarioResult {
  name: string;
  steps: StepResult[];
  passed: boolean;
}

export interface EvaluateResponse {
  callId: string;
  decision: string;
  reason: string;
  riskScore: number;
  latencyMs: number;
}
