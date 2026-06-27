# verdicter-action

Run [Verdicter](https://verdicter.dev) policy scenarios in CI. Catches policy regressions before they reach production by evaluating your sandbox steps against the live policy engine on every PR.

## Requirements

A Verdicter API key. Get one at [verdicter.dev](https://verdicter.dev).

## Setup

**1. Add your API key as a repository secret**

`Settings > Secrets and variables > Actions > New repository secret`

Name: `VERDICTER_API_KEY`

**2. Create `.verdicter/ci.yml` in your repo**

```yaml
scenarios:
  - name: "Support bot - reads should pass"
    agent_id: support_bot
    steps:
      - tool: db_read
        payload:
          table: customers
        expect: allow

  - name: "Support bot - destructive actions should be denied"
    agent_id: support_bot
    steps:
      - tool: bulk_delete
        payload:
          table: orders
        expect: deny
```

**3. Add the workflow**

```yaml
# .github/workflows/verdicter.yml
name: Verdicter policy check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  policy-check:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - name: Run Verdicter scenarios
        uses: QuackaDuck/verdicter-action@v1
        with:
          api-key: ${{ secrets.VERDICTER_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | Yes | - | Your Verdicter API key |
| `config` | No | `.verdicter/ci.yml` | Path to the scenario config file |
| `api-url` | No | `https://www.verdicter.dev` | Verdicter API base URL |
| `fail-on-unexpected` | No | `true` | Fail the workflow if any step produces an unexpected decision |
| `post-comment` | No | `true` | Post a summary comment on the pull request |

## Outputs

| Output | Description |
|---|---|
| `total` | Total steps evaluated |
| `passed` | Steps that matched the expected decision |
| `failed` | Steps that did not match |
| `result` | Overall result: `pass` or `fail` |

## Scenario format

Each scenario has an `agent_id` and a list of steps. Each step specifies a `tool`, an optional `payload`, and an optional `expect` value (`allow`, `deny`, `escalate`, or `modify`). Steps without `expect` are evaluated but never fail the check.

The `agent_id` can be overridden per step if a scenario spans multiple agents.
