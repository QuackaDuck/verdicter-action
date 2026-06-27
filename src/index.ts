import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { CIConfig, ScenarioResult, StepResult, Decision, EvaluateResponse } from "./types";

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(configPath: string): CIConfig {
  const abs = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), configPath);

  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}\n\nCreate .verdicter/ci.yml in your repository root. See https://verdicter.dev/docs/ci for the format.`);
  }

  const raw = fs.readFileSync(abs, "utf8");
  const parsed = yaml.load(raw) as CIConfig;

  if (!parsed?.scenarios || !Array.isArray(parsed.scenarios)) {
    throw new Error("Config must have a top-level 'scenarios' array.");
  }

  for (const [i, scenario] of parsed.scenarios.entries()) {
    if (!scenario.name) throw new Error(`scenarios[${i}] is missing a 'name' field.`);
    if (!scenario.agent_id) throw new Error(`scenarios[${i}] ('${scenario.name}') is missing an 'agent_id' field.`);
    if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
      throw new Error(`scenarios[${i}] ('${scenario.name}') must have at least one step.`);
    }
    for (const [j, step] of scenario.steps.entries()) {
      if (!step.tool) throw new Error(`scenarios[${i}].steps[${j}] is missing a 'tool' field.`);
    }
  }

  return parsed;
}

// ─── Evaluate a single step ───────────────────────────────────────────────────

async function evaluate(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  tool: string,
  payload: Record<string, unknown>,
): Promise<EvaluateResponse> {
  const url = `${apiUrl.replace(/\/$/, "")}/api/v1/evaluate`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "verdicter-action/1",
    },
    body: JSON.stringify({ agent_id: agentId, tool, payload: payload ?? {} }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Verdicter API returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<EvaluateResponse>;
}

// ─── PR comment ───────────────────────────────────────────────────────────────

function decisionIcon(passed: boolean, expected: Decision | null): string {
  if (expected === null) return "⚪";
  return passed ? "✅" : "❌";
}

function decisionBadge(decision: string): string {
  const upper = decision.toUpperCase();
  const map: Record<string, string> = {
    ALLOW: "🟢 ALLOW",
    DENY: "🔴 DENY",
    ESCALATE: "🟡 ESCALATE",
    MODIFY: "🔵 MODIFY",
  };
  return map[upper] ?? upper;
}

function buildComment(results: ScenarioResult[], totalPassed: number, totalFailed: number, totalSteps: number): string {
  const allPassed = totalFailed === 0;
  const header = allPassed
    ? `## ✅ Verdicter CI - All scenarios passed (${totalPassed}/${totalSteps})`
    : `## ❌ Verdicter CI - ${totalFailed} step${totalFailed !== 1 ? "s" : ""} failed (${totalPassed}/${totalSteps} passed)`;

  const sections = results.map((scenario) => {
    const icon = scenario.passed ? "✅" : "❌";
    const rows = scenario.steps.map((step) =>
      `| ${decisionIcon(step.passed, step.expected)} | \`${step.tool}\` | ${step.expected ? decisionBadge(step.expected) : "-"} | ${decisionBadge(step.decision)} | ${step.risk_score} | ${step.duration_ms}ms |`
    ).join("\n");

    return `### ${icon} ${scenario.name}

| | Tool | Expected | Got | Risk | Latency |
|---|---|---|---|---|---|
${rows}`;
  });

  const footer = allPassed
    ? `\n---\n*All policy checks passed. No regressions detected.*`
    : `\n---\n*${totalFailed} step${totalFailed !== 1 ? "s" : ""} produced unexpected decisions. Review your policy changes or update the expected outcomes in \`.verdicter/ci.yml\`.*`;

  return [header, ...sections, footer].join("\n\n");
}

// Direct GitHub REST API calls via fetch — no @actions/github SDK needed
async function postPRComment(token: string, comment: string): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    core.info("No GITHUB_EVENT_PATH — skipping PR comment.");
    return;
  }

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    core.info("Not a pull request — skipping PR comment.");
    return;
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const issueNumber = pr.number as number;
  const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Find an existing Verdicter comment to update rather than spamming on re-runs
  const listRes = await fetch(`${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`, { headers });
  const existing = listRes.ok
    ? ((await listRes.json()) as Array<{ id: number; body?: string }>).find((c) => c.body?.includes("Verdicter CI"))
    : null;

  if (existing) {
    await fetch(`${apiBase}/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body: comment }),
    });
  } else {
    await fetch(`${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: comment }),
    });
  }
}

// ─── Job summary ─────────────────────────────────────────────────────────────

async function writeJobSummary(results: ScenarioResult[], totalPassed: number, totalFailed: number, totalSteps: number): Promise<void> {
  const allPassed = totalFailed === 0;

  await core.summary
    .addHeading(allPassed ? `✅ Verdicter CI passed (${totalPassed}/${totalSteps})` : `❌ Verdicter CI failed (${totalFailed} unexpected)`, 2)
    .addTable([
      [
        { data: "Scenario", header: true },
        { data: "Tool", header: true },
        { data: "Expected", header: true },
        { data: "Got", header: true },
        { data: "Risk", header: true },
        { data: "Result", header: true },
      ],
      ...results.flatMap((scenario) =>
        scenario.steps.map((step) => [
          scenario.name,
          `\`${step.tool}\``,
          step.expected ?? "-",
          step.decision.toUpperCase(),
          String(step.risk_score),
          step.passed ? "✅ Pass" : "❌ Fail",
        ])
      ),
    ])
    .write();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const apiKey          = core.getInput("api-key", { required: true });
  const configPath      = core.getInput("config");
  const failOnUnexpected = core.getInput("fail-on-unexpected") !== "false";
  const shouldComment   = core.getInput("post-comment") !== "false";

  // Load config
  let config: CIConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    core.setFailed(String(err));
    return;
  }

  const apiUrl = config.api_url ?? core.getInput("api-url");
  core.info(`Verdicter API: ${apiUrl}`);
  core.info(`Loaded ${config.scenarios.length} scenario(s) from ${configPath}`);

  const scenarioResults: ScenarioResult[] = [];
  let totalSteps = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  // Run all scenarios
  for (const scenario of config.scenarios) {
    core.startGroup(`Scenario: ${scenario.name}`);
    const stepResults: StepResult[] = [];
    let scenarioPassed = true;

    for (const [stepIdx, step] of scenario.steps.entries()) {
      const agentId = step.agent_id ?? scenario.agent_id;
      const expected = step.expect ?? null;
      const t0 = Date.now();

      let decision: Decision;
      let riskScore = 0;
      let reason = "";

      try {
        const resp = await evaluate(apiUrl, apiKey, agentId, step.tool, step.payload ?? {});
        decision = resp.decision.toLowerCase() as Decision;
        riskScore = resp.riskScore;
        reason = resp.reason;
      } catch (err) {
        core.error(`Step ${stepIdx + 1} (${step.tool}) - API error: ${err}`);
        decision = "deny";
        reason = String(err);
      }

      const duration = Date.now() - t0;
      const passed = expected === null || decision === expected;

      const result: StepResult = {
        scenario: scenario.name,
        step: stepIdx + 1,
        tool: step.tool,
        expected,
        decision,
        risk_score: riskScore,
        reason,
        passed,
        duration_ms: duration,
      };

      stepResults.push(result);
      totalSteps++;

      if (passed) {
        totalPassed++;
        core.info(`  Step ${stepIdx + 1}: ${step.tool} -> ${decision.toUpperCase()} ✅`);
      } else {
        totalFailed++;
        scenarioPassed = false;
        core.error(`  Step ${stepIdx + 1}: ${step.tool} -> expected ${expected?.toUpperCase()} but got ${decision.toUpperCase()} ❌\n  Reason: ${reason}`);
      }
    }

    scenarioResults.push({ name: scenario.name, steps: stepResults, passed: scenarioPassed });
    core.endGroup();
  }

  // Set outputs
  core.setOutput("total", String(totalSteps));
  core.setOutput("passed", String(totalPassed));
  core.setOutput("failed", String(totalFailed));
  core.setOutput("result", totalFailed === 0 ? "pass" : "fail");

  // Job summary
  await writeJobSummary(scenarioResults, totalPassed, totalFailed, totalSteps);

  // PR comment
  if (shouldComment && process.env.GITHUB_TOKEN) {
    try {
      const comment = buildComment(scenarioResults, totalPassed, totalFailed, totalSteps);
      await postPRComment(process.env.GITHUB_TOKEN, comment);
    } catch (err) {
      core.warning(`Could not post PR comment: ${err}`);
    }
  }

  // Final result
  if (totalFailed > 0 && failOnUnexpected) {
    core.setFailed(`${totalFailed} scenario step${totalFailed !== 1 ? "s" : ""} produced unexpected decisions.`);
  } else {
    core.info(`\nVerdicter CI complete: ${totalPassed}/${totalSteps} steps passed.`);
  }
}

run().catch((err) => core.setFailed(String(err)));
