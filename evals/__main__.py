"""Explicit CLI: python -m evals {run,agent,compare}."""

import argparse
import asyncio
import json
import os
from pathlib import Path

from dotenv import dotenv_values

from app.services.agent.openai_cost_tracking import OpenAICostTracker
from app.services.agent.openai_inference import OpenAIInferenceAdapter, validate_openai_model
from evals.agent_models import AgentCase
from evals.agent_runner import build_snapshot, run_agent_cases
from evals.models import JudgeConfig, RegressionCase
from evals.runner import REPETITIONS, prepare_case
from evals.scheduling import CONCURRENCY, run_cases
from evals.selection import build_coverage, load_coverage, plan_selection

_REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


def openai_api_key() -> str:
    """The key for live runs: OPENAI_API_KEY from the shell, else from the repository's .env."""
    if "OPENAI_API_KEY" in os.environ and os.environ["OPENAI_API_KEY"] != "":
        return os.environ["OPENAI_API_KEY"]
    dotenv_path = _REPOSITORY_ROOT / ".env"
    if dotenv_path.is_file():
        values = dotenv_values(dotenv_path)
        if "OPENAI_API_KEY" in values and values["OPENAI_API_KEY"]:
            return values["OPENAI_API_KEY"]
    raise SystemExit("Live runs need OPENAI_API_KEY in the shell or in the repository's .env")


def write_new(path: Path, payload) -> None:
    with path.open("x", encoding="utf-8") as output:
        json.dump(payload, output, indent=2)
        output.write("\n")


async def run(arguments):
    if arguments.concurrency < 1:
        raise ValueError("Concurrency must be a positive integer")
    if arguments.repetitions < 1:
        raise ValueError("Repetitions must be a positive integer")
    cases = [RegressionCase.model_validate_json(path.read_text(encoding="utf-8")) for path in arguments.cases]
    if len({case.id for case in cases}) != len(cases):
        raise ValueError("Case IDs must be unique")
    judge = None
    if arguments.judge is not None:
        judge = JudgeConfig.model_validate_json(arguments.judge.read_text(encoding="utf-8"))
    # Validate everything before spending tokens or creating a report directory.
    prepared_cases = []
    for case in cases:
        validate_openai_model(case.model)
        prepared_cases.append(prepare_case(case))
        if any(step.expectation.kind == "output" for step in case.steps) and judge is None:
            raise ValueError("Output cases require --judge")
    if judge is not None:
        validate_openai_model(judge.model)
    plan, baseline = plan_selection(cases, prepared_cases, judge=judge,
        repetitions=arguments.repetitions, baseline_path=arguments.changed_since)
    selected_ids = {entry["case_id"] for entry in plan["selected"]}
    print(f"Selected {len(selected_ids)}/{len(cases)} cases; {len(plan['skipped'])} unchanged cases will not be rerun.")
    if arguments.changed_since is not None:
        for entry in plan["selected"]:
            print(f"  {entry['case_id']}: {entry['reason']}")
    if not arguments.live:
        print(f"Validated {len(cases)} cases; add --live to make provider calls ({arguments.repetitions} runs per case, concurrency {arguments.concurrency}).")
        return
    all_cases, all_prepared = cases, prepared_cases
    cases = [case for case in all_cases if case.id in selected_ids]
    prepared_cases = [prepared for prepared in all_prepared if prepared.id in selected_ids]
    costs = OpenAICostTracker()
    arguments.output.mkdir(parents=True, exist_ok=False)
    for index in range(len(cases)):
        (arguments.output / str(index)).mkdir()

    def preserve(index, outcome):
        write_new(arguments.output / str(index) / f"{outcome['repetition']:02d}.json", outcome)
        print(f"{cases[index].id} {outcome['repetition']}/{arguments.repetitions}: {outcome['status']}", flush=True)

    def preserve_case(index, report):
        write_new(arguments.output / str(index) / "report.json", report)
        print(f"{cases[index].id}: {report['counts']['correct']}/{arguments.repetitions} "
              f"({report['percent_correct']:g}%) correct; {report['counts']['error']} errors", flush=True)

    reports = []
    if cases:
        adapter = OpenAIInferenceAdapter(api_key=openai_api_key(), cost_tracker=costs)
        reports = await run_cases(cases, prepared_cases=prepared_cases, adapter=adapter, judge=judge,
            concurrency=arguments.concurrency, repetitions=arguments.repetitions,
            on_repetition=preserve, on_case=preserve_case)
    coverage = build_coverage(all_cases, all_prepared, reports=reports, baseline=baseline,
        judge=judge, repetitions=arguments.repetitions, report_path=arguments.output / "report.json")
    usage = costs.snapshot()
    token_usage = {"uncached_input_tokens": usage.uncached_input_tokens,
        "cached_input_tokens": usage.cached_input_tokens, "cache_write_tokens": usage.cache_write_tokens,
        "output_tokens": usage.output_tokens}
    write_new(arguments.output / "report.json", {"cases": reports, "selection": plan, "coverage": coverage,
        "concurrency": arguments.concurrency, "scheduling": "shared-prefix-warmup",
        "token_usage": token_usage, "estimated_cost_usd": str(usage.estimated_cost_usd)})
    print(f"Provider usage: {usage.cached_input_tokens} cached input tokens, "
          f"{usage.cache_write_tokens} cache-write tokens, {usage.uncached_input_tokens} uncached input tokens; "
          f"estimated cost ${usage.estimated_cost_usd}", flush=True)
    prior_failures = [entry for entry in coverage if entry["case_id"] in plan["skipped"]
                      and (entry["counts"]["incorrect"] or entry["counts"]["error"])]
    if prior_failures:
        print(f"{len(prior_failures)} unchanged cases retain earlier failures/errors; they were not rerun.")
    if any(report["counts"]["error"] for report in coverage):
        raise SystemExit(2)
    if any(report["counts"]["incorrect"] for report in coverage):
        raise SystemExit(1)


async def run_agent(arguments):
    """Agent-stage cases: the whole production agent loop, per model and thinking level."""
    cases = [AgentCase.model_validate_json(path.read_text(encoding="utf-8")) for path in arguments.cases]
    if len({case.id for case in cases}) != len(cases):
        raise ValueError("Case IDs must be unique")
    judge = None
    if arguments.judge is not None:
        judge = JudgeConfig.model_validate_json(arguments.judge.read_text(encoding="utf-8"))
        validate_openai_model(judge.model)
    # Validate everything before spending tokens or creating a report directory.
    for case in cases:
        if not case.reviewed:
            raise ValueError(f"Review expected behavior and set reviewed=true: {case.id}")
        validate_openai_model(case.model)
        build_snapshot(case, session_key="validation")
        if case.expectation.answer_criteria and judge is None:
            raise ValueError(f"Cases with answer criteria require --judge: {case.id}")
    trials = len(cases) * arguments.repetitions
    if not arguments.live:
        print(f"Validated {len(cases)} agent cases; --live would make {trials} agent runs "
              f"({arguments.repetitions} per case, Luna at Low thinking).")
        return
    costs = OpenAICostTracker()
    arguments.output.mkdir(parents=True, exist_ok=False)
    (arguments.output / "trials").mkdir()
    trial_number = 0

    def preserve(case, model, level, outcome):
        nonlocal trial_number
        trial_number += 1
        write_new(arguments.output / "trials" / f"{trial_number:05d}.json",
                  {"case_id": case.id, "model": model, "thinking_level": level, **outcome})
        detail = ""
        if outcome["status"] != "correct":
            detail = f" — {outcome['error'] or '; '.join(outcome['failures'])}"
        print(f"[{trial_number}/{trials}] {case.id} @ {model}/{level} #{outcome['repetition']}: "
              f"{outcome['status']}{detail}", flush=True)

    adapter = OpenAIInferenceAdapter(api_key=openai_api_key(), cost_tracker=costs)
    reports = await run_agent_cases(cases, adapter=adapter, judge=judge,
        repetitions=arguments.repetitions, concurrency=arguments.concurrency, on_trial=preserve)
    usage = costs.snapshot()
    summaries = [{key: value for key, value in report.items() if key != "outcomes"} for report in reports]
    write_new(arguments.output / "report.json", {"kind": "agent",
        "cases": summaries, "concurrency": arguments.concurrency,
        "token_usage": {"uncached_input_tokens": usage.uncached_input_tokens,
                        "cached_input_tokens": usage.cached_input_tokens,
                        "cache_write_tokens": usage.cache_write_tokens, "output_tokens": usage.output_tokens},
        "estimated_cost_usd": str(usage.estimated_cost_usd)})
    for report in summaries:
        print(f"{report['case_id']}: {report['counts']['correct']}/{report['repetitions']} correct; "
              f"{report['counts']['error']} errors")
    print(f"Estimated cost ${usage.estimated_cost_usd}", flush=True)
    if any(report["counts"]["error"] for report in summaries):
        raise SystemExit(2)
    if any(report["counts"]["incorrect"] for report in summaries):
        raise SystemExit(1)


def compare(arguments):
    baseline_report = json.loads(arguments.baseline.read_text(encoding="utf-8"))
    candidate_report = json.loads(arguments.candidate.read_text(encoding="utf-8"))
    baseline, candidate = baseline_report["cases"], candidate_report["cases"]
    if "coverage" in baseline_report or "coverage" in candidate_report:
        baseline = list(load_coverage(arguments.baseline).values())
        candidate = list(load_coverage(arguments.candidate).values())
        for report in [*baseline, *candidate]:
            report["percent_correct"] = 100 * report["counts"]["correct"] / report["repetitions"]
    left = {report["case_id"]: report for report in baseline}
    right = {report["case_id"]: report for report in candidate}
    if left.keys() != right.keys():
        raise ValueError("Comparisons require identical case sets")
    for case_id, before in left.items():
        after = right[case_id]
        if before["case_fingerprint"] != after["case_fingerprint"] or before["judge"] != after["judge"]:
            raise ValueError(f"Case context, expectations, model, or judge changed: {case_id}")
        if ("judge_schema" in before and before["judge_schema"] and after["judge_schema"]
                and before["judge_schema"] != after["judge_schema"]):
            raise ValueError(f"Judge schema changed: {case_id}")
        if before["repetitions"] != after["repetitions"]:
            raise ValueError("Comparisons require equal repetitions per case")
        difference = after["percent_correct"] - before["percent_correct"]
        print(f"{case_id}: {before['percent_correct']:g}% → {after['percent_correct']:g}% "
              f"({difference:+g} percentage points); errors "
              f"{before['counts']['error']} → {after['counts']['error']}")
        if "source_report" in after and after["source_report"] != str(arguments.candidate.resolve()):
            print(f"  Not rerun; historical result from {after['source_report']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    execute = commands.add_parser("run")
    execute.add_argument("--repetitions", type=int, default=REPETITIONS, help="Independent trials per case (default: 5)")
    execute.add_argument("--concurrency", type=int, default=CONCURRENCY,
        help="Maximum concurrent requests (default: 4; use 1 for serial execution)")
    execute.add_argument("cases", type=Path, nargs="+")
    execute.add_argument("--judge", type=Path)
    execute.add_argument("--live", action="store_true")
    execute.add_argument("--changed-since", type=Path,
        help="Rebuild all requests but run only changed/new cases relative to this report")
    execute.add_argument("--output", type=Path, required=True, help="New directory for reports")
    agent = commands.add_parser("agent", help="Run agent-stage cases through the production agent loop")
    agent.add_argument("cases", type=Path, nargs="+")
    agent.add_argument("--judge", type=Path)
    agent.add_argument("--live", action="store_true")
    agent.add_argument("--repetitions", type=int, default=REPETITIONS, help="Runs per case and setting (default: 5)")
    agent.add_argument("--concurrency", type=int, default=CONCURRENCY, help="Agent runs at once (default: 4)")
    agent.add_argument("--output", type=Path, required=True, help="New directory for reports")
    comparison = commands.add_parser("compare")
    comparison.add_argument("baseline", type=Path)
    comparison.add_argument("candidate", type=Path)
    arguments = parser.parse_args()
    if arguments.command == "run":
        asyncio.run(run(arguments))
    elif arguments.command == "agent":
        asyncio.run(run_agent(arguments))
    else:
        compare(arguments)


if __name__ == "__main__":
    main()
