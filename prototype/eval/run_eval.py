#!/usr/bin/env python3
"""Offline golden-set eval for the MeetingCast translate prompt.

Runs each golden case through the Anthropic API with the SAME system prompt,
glossary rendering and <context> wrapping the shipped Rust path uses
(src-tauri/src/translator.rs), then scores the output with the deterministic
parity checks in checks.py. Use it as a regression gate when editing
prompts/translate_system.txt — point --prompt-file at a candidate to A/B.

COST SAFETY. This calls a billable API only after an explicit confirmation:
  * --dry-run  prints the cost estimate + the first 2 rendered request bodies
               and EXITS before any network call. Use this to review.
  * --yes      skips the interactive prompt (for CI). Without it you get an
               input() confirmation and anything but 'y' aborts.
The estimate is printed on every invocation before a single call is made.

Run (cwd = prototype/):
  .venv/bin/python eval/run_eval.py --dry-run
  .venv/bin/python eval/run_eval.py            # asks before spending
  .venv/bin/python eval/run_eval.py --yes      # no prompt (spends money)
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from checks import run_expectations  # noqa: E402

# Full target-language labels substituted for {lang} in the system prompt —
# identical to translator.rs `target_lang_name`.
LANG_LABELS = {"en": "English", "vi": "Vietnamese (Tiếng Việt)"}

# Cost model. USD per 1M tokens (input, output). Assumed per-call token volume
# is deliberately generous so the printed estimate is an upper-ish bound.
PRICES = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-4-6": (3.0, 15.0),
}
EST_INPUT_TOKENS = 500
EST_OUTPUT_TOKENS = 100


def resolve(p: str) -> Path:
    """Resolve a possibly-relative path against the script's directory (eval/),
    so the documented relative defaults work regardless of cwd."""
    path = Path(p)
    return path if path.is_absolute() else (SCRIPT_DIR / path).resolve()


def render_glossary_section(entries: list[dict], target: str) -> str:
    """Mirror config.rs `render_glossary_section`: only entries with a non-empty
    term and non-empty target rendering; empty string when nothing applies."""
    if not entries:
        return ""
    lines: list[str] = []
    for e in entries:
        term = e.get("term", "")
        if not term:
            continue
        translated = e.get("vi", "") if target == "vi" else e.get("en", "")
        if not translated:
            continue
        lines.append(f"- {term} → {translated}")
    if not lines:
        return ""
    return "\n\n術語表（以下中文一律使用對應譯法，不要意譯）：\n" + "\n".join(lines)


def build_system(template: str, target: str, glossary: list[dict]) -> str:
    """Substitute {lang} and {glossary_section} exactly like translator.rs."""
    return template.replace("{lang}", LANG_LABELS[target]).replace(
        "{glossary_section}", render_glossary_section(glossary, target)
    )


def build_user_message(text: str, target: str, context: list[dict]) -> str:
    """Wrap prior (zh, translation) pairs in the <context> block, matching
    translator.rs `build_user_message`. The pair label is the raw target code
    ("en"/"vi") — that's the second argument the Rust caller passes. Empty
    context returns the text unchanged."""
    if not context:
        return text
    parts = ["<context>\n"]
    for pair in context:
        parts.append("zh: " + pair["zh"] + "\n")
        parts.append(target + ": " + pair["translation"] + "\n\n")
    parts.append("</context>\n\n")
    parts.append(text)
    return "".join(parts)


def build_body(model: str, system: str, user_message: str) -> dict:
    """The exact request body shape sent to Anthropic (mirrors translator.rs:
    structured system block with ephemeral cache_control, non-streaming here)."""
    return {
        "model": model,
        "max_tokens": 1024,
        "system": [
            {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
        ],
        "messages": [{"role": "user", "content": user_message}],
    }


def load_cases(path: Path) -> list[dict]:
    cases = []
    with path.open(encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                cases.append(json.loads(line))
            except json.JSONDecodeError as e:
                sys.exit(f"golden set parse error at {path}:{lineno}: {e}")
    return cases


def effective_targets(case: dict, requested: list[str]) -> list[str]:
    """Intersection of a case's declared targets with the CLI --targets,
    order-preserving on the requested list."""
    case_targets = case.get("targets", ["en", "vi"])
    return [t for t in requested if t in case_targets]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Offline golden-set eval for the translate prompt.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--cases", default="golden/translation_cases.jsonl")
    parser.add_argument("--targets", default="en,vi")
    parser.add_argument("--model", default="claude-haiku-4-5")
    parser.add_argument(
        "--prompt-file",
        default="../../src-tauri/prompts/translate_system.txt",
        help="System prompt template (single source of truth); A/B a candidate here.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print estimate + first 2 request bodies and exit before any API call.",
    )
    parser.add_argument(
        "--yes", action="store_true", help="Skip the interactive cost confirmation."
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Results JSONL path (default: results/<timestamp>.jsonl).",
    )
    args = parser.parse_args()

    cases_path = resolve(args.cases)
    prompt_path = resolve(args.prompt_file)
    requested_targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    for t in requested_targets:
        if t not in LANG_LABELS:
            sys.exit(f"unsupported target {t!r} (supported: {', '.join(LANG_LABELS)})")

    if not prompt_path.exists():
        sys.exit(f"prompt file not found: {prompt_path}")
    template = prompt_path.read_text(encoding="utf-8")
    cases = load_cases(cases_path)

    # Build the ordered work list: one (case, target) per API call.
    work: list[tuple[dict, str]] = []
    for case in cases:
        for target in effective_targets(case, requested_targets):
            work.append((case, target))

    n_calls = len(work)
    price_in, price_out = PRICES.get(args.model, (1.0, 5.0))
    est_in = n_calls * EST_INPUT_TOKENS
    est_out = n_calls * EST_OUTPUT_TOKENS
    est_cost = est_in / 1e6 * price_in + est_out / 1e6 * price_out

    print("=" * 60)
    print("COST ESTIMATE (before any API call)")
    print(f"  cases           : {len(cases)}")
    print(f"  targets         : {', '.join(requested_targets)}")
    print(f"  API calls       : {n_calls}  (cases x targets)")
    print(f"  model           : {args.model}  (${price_in}/${price_out} per MTok)")
    print(f"  est input tokens: {est_in:,}  (~{EST_INPUT_TOKENS}/call)")
    print(f"  est output tok. : {est_out:,}  (~{EST_OUTPUT_TOKENS}/call)")
    print(f"  est cost        : ${est_cost:.4f} USD")
    if args.model not in PRICES:
        print(f"  (unknown model — priced as haiku fallback ${price_in}/${price_out})")
    print("=" * 60)

    if args.dry_run:
        print("\n--dry-run: sample rendered request bodies (first 2), no API call:\n")
        for case, target in work[:2]:
            system = build_system(template, target, case.get("glossary", []))
            user_message = build_user_message(
                case["zh"], target, case.get("context", [])
            )
            body = build_body(args.model, system, user_message)
            print(f"--- id={case['id']} target={target} ---")
            print(json.dumps(body, ensure_ascii=False, indent=2))
            print()
        print("dry-run complete — exited before any network call.")
        return 0

    if not args.yes:
        reply = input(f"\nProceed with {n_calls} billable API calls? [y/N] ").strip().lower()
        if reply != "y":
            print("aborted — no API call made.")
            return 0

    # Only now do we touch the network. Import + key loading deferred so a
    # dry-run never even needs the dependency or a key present.
    import anthropic  # noqa: E402
    from dotenv import load_dotenv  # noqa: E402

    load_dotenv(SCRIPT_DIR.parent / ".env")
    try:
        client = anthropic.Anthropic()
    except Exception as e:  # noqa: BLE001
        sys.exit(f"failed to init Anthropic client (is ANTHROPIC_API_KEY set?): {e}")

    out_path = resolve(
        args.out
        if args.out
        else f"results/{datetime.now().strftime('%Y%m%d-%H%M%S')}.jsonl"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    tally: dict[str, dict[str, int]] = {}
    total_in = total_out = 0

    for case, target in work:
        category = case.get("category", "uncategorized")
        system = build_system(template, target, case.get("glossary", []))
        user_message = build_user_message(case["zh"], target, case.get("context", []))
        body = build_body(args.model, system, user_message)
        try:
            resp = client.messages.create(**body)
            translation = "".join(
                b.text for b in resp.content if getattr(b, "type", None) == "text"
            )
            usage = {
                "input_tokens": getattr(resp.usage, "input_tokens", None),
                "output_tokens": getattr(resp.usage, "output_tokens", None),
                "cache_creation_input_tokens": getattr(
                    resp.usage, "cache_creation_input_tokens", None
                ),
                "cache_read_input_tokens": getattr(
                    resp.usage, "cache_read_input_tokens", None
                ),
            }
            total_in += usage["input_tokens"] or 0
            total_out += usage["output_tokens"] or 0
            stop_reason = getattr(resp, "stop_reason", None)
            failures = run_expectations(case, target, translation)
        except Exception as e:  # noqa: BLE001
            translation = ""
            usage = {}
            stop_reason = None
            failures = [f"API error: {e}"]

        passed = not failures
        rec = {
            "id": case["id"],
            "category": category,
            "target": target,
            "zh": case["zh"],
            "translation": translation,
            "pass": passed,
            "failures": failures,
            "stop_reason": stop_reason,
            "usage": usage,
        }
        results.append(rec)
        bucket = tally.setdefault(category, {"pass": 0, "fail": 0})
        bucket["pass" if passed else "fail"] += 1

        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {case['id']} ({target})")
        if not passed:
            for msg in failures:
                print(f"        - {msg}")

    with out_path.open("w", encoding="utf-8") as f:
        for rec in results:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # Summary table by rule-category.
    print("\n" + "=" * 60)
    print(f"{'category':<20}{'pass':>6}{'fail':>6}{'total':>7}")
    print("-" * 60)
    total_pass = total_fail = 0
    for category in sorted(tally):
        b = tally[category]
        total_pass += b["pass"]
        total_fail += b["fail"]
        print(f"{category:<20}{b['pass']:>6}{b['fail']:>6}{b['pass'] + b['fail']:>7}")
    print("-" * 60)
    print(f"{'TOTAL':<20}{total_pass:>6}{total_fail:>6}{total_pass + total_fail:>7}")
    print("=" * 60)
    print(f"actual tokens: {total_in:,} in / {total_out:,} out")
    actual_cost = total_in / 1e6 * price_in + total_out / 1e6 * price_out
    print(f"actual cost  : ${actual_cost:.4f} USD")
    print(f"results      : {out_path}")

    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
