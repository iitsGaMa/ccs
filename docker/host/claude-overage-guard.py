#!/usr/bin/env python3
"""Pause one Claude OAuth account in CLIProxy before it spends extra-usage credits.

Claude subscriptions with extra usage enabled keep answering 200 after the plan
quota runs out and bill credits instead of returning 429. CLIProxy only rotates
on errors, so it would keep draining credits. This guard disables the account in
CLIProxy when any plan window reaches the threshold, or when its credit usage
grows, and re-enables it after the window resets.

It never re-enables an account that it did not disable itself.

Inputs:
  - CLIProxy management API (auth-files: per-request rate-limit headers, disabled flag)
  - CCS dashboard quota cache (<ccs home>/cache/claude-quota/<email>.json)

Run once per invocation (systemd timer). Stdlib only.
"""

import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

EMAIL = os.environ.get("GUARD_EMAIL", "aymeric.deloche@dotsafe.fr")
THRESHOLD = float(os.environ.get("GUARD_THRESHOLD", "0.95"))
CCS_HOME = os.environ.get("GUARD_CCS_HOME", "/var/lib/docker/volumes/ccs_animou_home/_data")
MGMT_URL = os.environ.get("GUARD_MGMT_URL", "http://100.95.152.41:8317/v0/management")
STATE_PATH = os.environ.get("GUARD_STATE", "/var/lib/ccs-claude-overage-guard/state.json")
DRY_RUN = os.environ.get("GUARD_DRY_RUN") == "1"
# Re-enable even without a fresh cache reading this long after the reset time.
STALE_RESUME_GRACE_S = 15 * 60
RESUME_MARGIN_S = 60


def log(msg):
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}", flush=True)


def management_key():
    with open(os.path.join(CCS_HOME, "config.yaml")) as f:
        for line in f:
            m = re.match(r"^\s+management_secret:\s*['\"]?([^'\"\s]+)", line)
            if m:
                return m.group(1)
    raise RuntimeError("management_secret not found in CCS config.yaml")


def mgmt(key, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MGMT_URL + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read() or b"{}")


def parse_iso(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def read_cache():
    name = re.sub(r"[^A-Za-z0-9-]", "_", EMAIL) + ".json"
    try:
        with open(os.path.join(CCS_HOME, "cache", "claude-quota", name)) as f:
            good = json.load(f).get("lastGood") or {}
    except FileNotFoundError:
        return None
    windows = [
        {
            "name": w.get("rateLimitType"),
            "util": float(w.get("utilization") or 0),
            "reset": parse_iso(w.get("resetAt")),
        }
        for w in good.get("windows", [])
    ]
    credits = good.get("credits") or {}
    used = (credits.get("used") or {}).get("value") if credits.get("enabled") else None
    return {
        "updated": (good.get("lastUpdated") or 0) / 1000,
        "windows": windows,
        "credits_used": used,
    }


def header_windows(entry):
    quota = entry.get("quota") or {}
    sig = quota.get("signals") or {}
    observed = parse_iso((quota.get("observed_at") or "")[:26] + "Z") if quota.get("observed_at") else None
    out = []
    for key, name in (("5h", "five_hour"), ("7d", "seven_day")):
        util = sig.get(f"Anthropic-Ratelimit-Unified-{key}-Utilization")
        if util is None:
            continue
        reset = sig.get(f"Anthropic-Ratelimit-Unified-{key}-Reset")
        out.append({"name": name, "util": float(util), "reset": float(reset) if reset else None})
    claim = sig.get("Anthropic-Ratelimit-Unified-Representative-Claim", "")
    return observed, out, "overage" in claim


def freshest_windows(cache, hdr_observed, hdr_windows):
    """Per window name, keep the reading from the most recent source."""
    merged = {}
    if cache:
        for w in cache["windows"]:
            merged[w["name"]] = (cache["updated"], w)
    for w in hdr_windows:
        if hdr_observed and (w["name"] not in merged or hdr_observed >= merged[w["name"]][0]):
            merged[w["name"]] = (hdr_observed, w)
    return [w for _, w in merged.values()]


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), mode=0o700, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE_PATH)


def set_disabled(key, auth_name, disabled):
    if DRY_RUN:
        log(f"dry-run: would set disabled={disabled} on {auth_name}")
        return
    mgmt(key, "PATCH", "/auth-files/status", {"name": auth_name, "disabled": disabled})


def main():
    key = management_key()
    files = mgmt(key, "GET", "/auth-files").get("files", [])
    entry = next((f for f in files if f.get("email") == EMAIL), None)
    if entry is None:
        log(f"{EMAIL} not found in CLIProxy auth files; nothing to do")
        return
    auth_name = entry["name"]
    now = time.time()
    state = load_state()
    cache = read_cache()
    hdr_observed, hdr_windows, overage_claim = header_windows(entry)
    windows = freshest_windows(cache, hdr_observed, hdr_windows)
    over = [w for w in windows if w["util"] >= THRESHOLD]
    credits_used = cache["credits_used"] if cache else None

    if state.get("paused"):
        if not entry.get("disabled"):
            log("account was re-enabled outside the guard; dropping guard state")
            save_state({"credits_baseline": credits_used})
            return
        if now < state["resume_at"] + RESUME_MARGIN_S:
            return
        cache_fresh = cache is not None and cache["updated"] > state["resume_at"]
        if cache_fresh:
            still_over = [w for w in cache["windows"] if w["util"] >= THRESHOLD]
            if still_over:
                resets = [w["reset"] for w in still_over if w["reset"]]
                state["resume_at"] = max(resets) if resets else now + 3600
                log(f"still over threshold after reset ({describe(still_over)}); waiting until {iso(state['resume_at'])}")
                save_state(state)
                return
        elif now < state["resume_at"] + STALE_RESUME_GRACE_S:
            return
        set_disabled(key, auth_name, False)
        log(f"re-enabled {auth_name} (paused for: {state.get('reason')})")
        if not DRY_RUN:
            save_state({"credits_baseline": credits_used})
        return

    if entry.get("disabled"):
        return  # disabled by a human: not ours to manage

    baseline = state.get("credits_baseline")
    credits_grew = credits_used is not None and baseline is not None and credits_used > baseline + 1e-6
    if not (over or credits_grew or overage_claim):
        if baseline is None and credits_used is not None and not DRY_RUN:
            save_state({"credits_baseline": credits_used})
        return

    reasons = []
    if over:
        reasons.append(f"threshold {THRESHOLD:.0%} reached: {describe(over)}")
    if credits_grew:
        reasons.append(f"extra-usage credits grew {baseline} -> {credits_used}")
    if overage_claim:
        reasons.append("rate-limit claim is overage")
    resets = [w["reset"] for w in (over or windows) if w["reset"] and w["reset"] > now]
    resume_at = max(resets) if over and resets else (min(resets) if resets else now + 3600)
    set_disabled(key, auth_name, True)
    log(f"paused {auth_name} until {iso(resume_at)}: {'; '.join(reasons)}")
    if not DRY_RUN:
        save_state({"paused": True, "reason": "; ".join(reasons), "resume_at": resume_at,
                    "paused_at": now, "credits_baseline": credits_used})


def describe(windows):
    return ", ".join(f"{w['name']}={w['util']:.0%}" for w in windows)


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="minutes")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # keep the timer alive; surface the error in the journal
        log(f"error: {exc}")
        sys.exit(1)
