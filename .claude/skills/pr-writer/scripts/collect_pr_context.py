#!/usr/bin/env python3
"""Gathers everything needed to draft a PR title/description, deterministically.

Reads git history/diff between a base branch and HEAD, finds a repo PR
template if one exists, checks every commit ahead of base for AI/agent
authorship traces, and reports the repo's own git config. Prints one JSON
object to stdout — the caller (an LLM) uses it to draft the PR text and
decide whether an agent-trace warning needs to go to the user first.

This script only reads. It never amends, rebases, or force-pushes anything.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Patterns that suggest a commit (or the repo's own git config) traces back to
# an AI coding agent rather than a human. Matched case-insensitively against
# author/committer name+email for AUTHOR_PATTERNS, and against the commit
# subject+body for BODY_PATTERNS (trailers like "Co-Authored-By: Claude" or a
# session link live in the body, not the author field).
AUTHOR_PATTERNS = [
    r"claude",
    r"anthropic",
    r"copilot",
    r"chatgpt",
    r"\bopenai\b",
    r"\bcodex\b",
    r"noreply@anthropic\.com",
    r"\bai[- ]?bot\b",
    r"\bbot@",
]
BODY_PATTERNS = [
    r"co-authored-by:\s*claude",
    r"generated (with|by)\s*(claude|copilot|chatgpt|an? ai)",
    r"claude-session",
    r"claude\.ai/code",
    r"🤖",
    r"\bai[- ]generated\b",
]

PR_TEMPLATE_CANDIDATES = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
]

CONVENTION_DOC_CANDIDATES = ["CLAUDE.md", "CONTRIBUTING.md", "AGENTS.md", ".github/CONTRIBUTING.md"]

RECORD_SEP = "\x1e"
FIELD_SEP = "\x1f"


def run(args, cwd):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def detect_base(repo, explicit_base):
    if explicit_base:
        code, _, _ = run(["rev-parse", "--verify", explicit_base], repo)
        if code == 0:
            return explicit_base
        code, _, _ = run(["rev-parse", "--verify", f"origin/{explicit_base}"], repo)
        if code == 0:
            return f"origin/{explicit_base}"
        raise SystemExit(f"error: base ref '{explicit_base}' not found (tried it plain and as origin/{explicit_base})")

    code, out, _ = run(["symbolic-ref", "refs/remotes/origin/HEAD"], repo)
    if code == 0 and out:
        return out.replace("refs/remotes/", "", 1)

    for candidate in ("origin/main", "origin/master", "main", "master"):
        code, _, _ = run(["rev-parse", "--verify", candidate], repo)
        if code == 0:
            return candidate

    raise SystemExit(
        "error: couldn't auto-detect a base branch (no origin/HEAD, no origin/main, no origin/master, no main, no master) — pass --base explicitly"
    )


def find_matches(text, patterns):
    hits = []
    for pattern in patterns:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            hits.append({"pattern": pattern, "matched_text": m.group(0)})
    return hits


def collect_commits(repo, base, head):
    code, out, err = run(["log", "--format=%H", f"{base}..{head}"], repo)
    if code != 0:
        raise SystemExit(f"error: git log {base}..{head} failed: {err}")
    shas = [s for s in out.splitlines() if s]

    commits = []
    for sha in shas:
        fmt = FIELD_SEP.join(["%an", "%ae", "%cn", "%ce", "%s", "%b"])
        code, out, err = run(["show", "-s", f"--format={fmt}", sha], repo)
        if code != 0:
            continue
        parts = out.split(FIELD_SEP)
        # %b can itself contain no FIELD_SEP, but pad defensively in case a future
        # format tweak introduces one.
        author_name, author_email, committer_name, committer_email, subject = parts[:5]
        body = FIELD_SEP.join(parts[5:]) if len(parts) > 5 else ""

        flags = []
        for field_name, value in (
            ("author_name", author_name),
            ("author_email", author_email),
            ("committer_name", committer_name),
            ("committer_email", committer_email),
        ):
            for hit in find_matches(value, AUTHOR_PATTERNS):
                flags.append({"field": field_name, "value": value, **hit})
        for hit in find_matches(f"{subject}\n{body}", BODY_PATTERNS):
            flags.append({"field": "subject_or_body", **hit})

        commits.append(
            {
                "sha": sha,
                "short_sha": sha[:7],
                "author_name": author_name,
                "author_email": author_email,
                "committer_name": committer_name,
                "committer_email": committer_email,
                "subject": subject,
                "body": body,
                "agent_trace_flags": flags,
            }
        )
    return commits


def find_pr_template(repo):
    for rel in PR_TEMPLATE_CANDIDATES:
        path = repo / rel
        if path.is_file():
            return {"path": rel, "content": path.read_text(errors="replace")}
    template_dir = repo / ".github" / "PULL_REQUEST_TEMPLATE"
    if template_dir.is_dir():
        files = sorted(p.name for p in template_dir.glob("*.md"))
        if files:
            first = template_dir / files[0]
            return {
                "path": f".github/PULL_REQUEST_TEMPLATE/{files[0]}",
                "content": first.read_text(errors="replace"),
                "other_templates_in_dir": files[1:],
            }
    return None


def find_convention_docs(repo):
    return [rel for rel in CONVENTION_DOC_CANDIDATES if (repo / rel).is_file()]


def get_git_config(repo):
    def cfg(key):
        code, out, _ = run(["config", "--get", key], repo)
        return out if code == 0 and out else None

    name = cfg("user.name")
    email = cfg("user.email")
    return {
        "user_name": name,
        "user_email": email,
        "user_name_is_set": name is not None,
        "user_email_is_set": email is not None,
        "email_matches_agent_pattern": bool(email and find_matches(email, AUTHOR_PATTERNS)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Path to the git repo (default: current directory)")
    parser.add_argument("--base", default=None, help="Base branch/ref to diff against (default: auto-detect)")
    parser.add_argument("--diff-line-limit", type=int, default=4000, help="Max diff lines to include inline before truncating to a file list")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if run(["rev-parse", "--is-inside-work-tree"], repo)[0] != 0:
        raise SystemExit(f"error: {repo} is not a git repository")

    code, head, _ = run(["rev-parse", "--abbrev-ref", "HEAD"], repo)
    if code != 0 or head == "HEAD":
        raise SystemExit("error: HEAD is detached — checkout a branch first")

    base = detect_base(repo, args.base)
    code, merge_base, err = run(["merge-base", base, head], repo)
    if code != 0:
        raise SystemExit(f"error: no common ancestor between {base} and {head}: {err}")

    commits = collect_commits(repo, base, head)

    _, diff_stat, _ = run(["diff", "--stat", f"{base}...{head}"], repo)
    _, full_diff, _ = run(["diff", f"{base}...{head}"], repo)
    diff_lines = full_diff.splitlines()
    truncated = len(diff_lines) > args.diff_line_limit
    diff_payload = None if truncated else full_diff
    changed_files = []
    if truncated:
        _, name_status, _ = run(["diff", "--name-status", f"{base}...{head}"], repo)
        changed_files = name_status.splitlines()

    result = {
        "repo_path": str(repo),
        "base_ref": base,
        "head_ref": head,
        "merge_base_sha": merge_base,
        "commit_count": len(commits),
        "commits": commits,
        "any_agent_trace_flags": any(c["agent_trace_flags"] for c in commits),
        "diff_stat": diff_stat,
        "diff": diff_payload,
        "diff_truncated": truncated,
        "diff_line_count": len(diff_lines),
        "changed_files_if_truncated": changed_files,
        "pr_template": find_pr_template(repo),
        "convention_docs_found": find_convention_docs(repo),
        "git_config": get_git_config(repo),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
