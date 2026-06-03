#!/usr/bin/env python3
"""
Agent Workspaces — sync engine.

Captures past agent sessions from ~/.codex, ~/.claude, ~/.agents into compact,
searchable Obsidian Markdown (index + digest, NOT verbatim transcripts), and
mines debugging/fix moments into insight candidates for later skill synthesis.

Design guarantees:
  * READ-ONLY on the source dirs (never writes/deletes there).
  * $0 tokens — pure deterministic parsing, no LLM calls.
  * Incremental — only re-parses new/changed transcripts (state.json).
  * Secret-safe — redacts obvious credentials, never copies auth/secret files.

Usage:
  python3 sync.py                # incremental sync
  python3 sync.py --full         # ignore state, rebuild everything
  python3 sync.py --dry-run      # parse + report, write nothing
  python3 sync.py --limit N      # cap transcripts processed (testing)
"""
import argparse, collections, datetime, glob, hashlib, json, os, re, sys

HOME  = os.path.expanduser("~")
VAULT = os.environ.get("CLAUDIAN_VAULT", "/Users/home/v1")
ROOT  = os.path.join(VAULT, "Agent Workspaces")
SYNC  = os.path.join(ROOT, "_sync")
STATE_PATH = os.path.join(SYNC, "state.json")
SYNTH_STATE = os.path.join(SYNC, ".synth-state.json")   # written by synthesize.py: {"done": [keys]}
INSIGHTS = os.path.join(ROOT, "_insights")

def cand_key(c):
    """Stable identity for a candidate — MUST match synthesize.py's key()."""
    return c.get("note", "") + "|" + c.get("fix", "")[:50]

def load_synth_done():
    """Durable 'synthesized' set = union of the state file AND the existing archive file.
    Either alone is a single point of failure (the state file can be deleted; the archive
    can be clobbered) — the union makes the lifecycle self-healing so synthesized
    candidates never silently reappear in the active queue."""
    done = set()
    if os.path.isfile(SYNTH_STATE):
        try: done |= set(json.load(open(SYNTH_STATE)).get("done", []))
        except Exception: pass
    archive = os.path.join(INSIGHTS, "candidates_synthesized.jsonl")
    if os.path.isfile(archive):
        try:
            for line in open(archive):
                if line.strip():
                    done.add(cand_key(json.loads(line)))
        except Exception: pass
    return done

CODEX  = os.path.join(HOME, ".codex")
CLAUDE = os.path.join(HOME, ".claude")
AGENTS = os.path.join(HOME, ".agents")

# ---------------------------------------------------------------- redaction
SECRET_RX = [
    # provider API keys
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),                 # OpenAI / Anthropic (sk-ant-…)
    re.compile(r"\bxai-[A-Za-z0-9]{16,}\b"),               # xAI
    re.compile(r"\bhf_[A-Za-z0-9]{16,}\b"),                # HuggingFace
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),             # GitHub
    re.compile(r"AKIA[0-9A-Z]{16}"),                       # AWS
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),           # Slack
    re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),  # JWT
    # labelled secrets:  api_key: …  /  "token"="…"
    re.compile(r"(?i)(api[_-]?key|secret|token|password|passwd|bearer|authorization|mnemonic|seed[_ ]?phrase|private[_ ]?key|secret[_ ]?key)\s*[:=]\s*[\"']?[^\s,;'\"]{8,}"),
    # credentials embedded in URLs / connection strings:  scheme://user:pass@host
    re.compile(r"(?i)\b[a-z][a-z0-9+.\-]*://[^\s/@]+:[^\s/@]+@"),
    # api key / token in a URL query string:  ?api-key=…  &token=…
    re.compile(r"(?i)[?&](api[_-]?key|access[_-]?token|token|key|secret|password)=[^&\s\"'<>]+"),
    # crypto key material
    re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{64,}\b"),          # long base58 (Solana secret keys ~88 chars)
    re.compile(r"\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){47,}\s*\]"),  # 48+ byte int-array keypair
    # PII
    re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),  # email addresses
]
def redact(s):
    if not s: return s
    for rx in SECRET_RX:
        s = rx.sub("«redacted»", s)
    return s

def trunc(s, n=600):
    s = (s or "").strip()
    s = re.sub(r"\s+\n", "\n", s)
    if len(s) <= n: return s
    return s[:n].rstrip() + " …"

def oneline(s, n=140):
    s = re.sub(r"\s+", " ", (s or "").strip())
    return (s[:n] + "…") if len(s) > n else s

def slug(s, n=70):
    s = re.sub(r"[^\w\s-]", "", (s or "").lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return (s[:n].strip("-")) or "untitled"

def yaml_val(v):
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return str(v)
    if isinstance(v, list): return "[" + ", ".join(yaml_val(x) for x in v) + "]"
    s = str(v).replace('"', "'")
    return '"' + s + '"'

def frontmatter(d):
    out = ["---"]
    for k, v in d.items():
        out.append(f"{k}: {yaml_val(v)}")
    out.append("---")
    return "\n".join(out)

def fdate(ts):
    """Normalize an ISO-ish timestamp to YYYY-MM-DD HH:MM (UTC-naive)."""
    if not ts: return ""
    try:
        ts2 = ts.replace("Z", "+00:00")
        dt = datetime.datetime.fromisoformat(ts2)
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)[:16].replace("T", " ")

# ---------------------------------------------------------------- mining
ERROR_RX = re.compile(
    r"(?i)(traceback \(most recent call last\)|\bexception\b|\berror:|\berrno\b|"
    r"\bfatal\b|segmentation fault|\bpanic:|command not found|no such file|"
    r"cannot find|\bundefined\b|is not defined|is not a function|failed to |"
    r"\bassert(ion)?\b|test(s)? failed|\bFAILED\b|npm ERR!|ModuleNotFoundError|"
    r"TypeError|ValueError|KeyError|NullPointer|unhandled|permission denied|"
    r"connection refused|timed out|ENOENT|404|500 internal)"
)
FIX_RX = re.compile(
    r"(?i)(fixed|resolved|the (issue|problem|bug|error) was|root cause|turned out|"
    r"works now|passing now|now passes|the fix|corrected|patched|should work now|"
    r"that did it|got it working|solution was|the trick was|because (it|the))"
)
def err_score(t):  return len(ERROR_RX.findall(denoise(t) or ""))
def fix_score(t):  return len(FIX_RX.findall(t or ""))

# Noise that pollutes tool output on this machine (shell warning + Codex runner telemetry).
NOISE_RX = [
    re.compile(r"(?m)^.*\.zshenv:.*no such file.*$\n?"),
    re.compile(r"(?im)^.*\b(chunk id|wall time|process (running|exited)|time to first token|session id)\b.*$\n?"),
    re.compile(r"(?m)^\s*<[^>]+>\s*$\n?"),  # lone xml-ish wrapper lines
]
def denoise(t):
    t = t or ""
    for rx in NOISE_RX:
        t = rx.sub("", t)
    return t

def is_prose(t):
    """True when t reads like an explanatory sentence, not code/diff/log."""
    t = (t or "").strip()
    words = t.split()
    if len(words) < 6: return False
    letters = sum(c.isalpha() or c.isspace() for c in t)
    if letters < 0.62 * max(len(t), 1): return False          # too much code/punctuation
    if re.match(r"^\s*\d+[\s|:]", t): return False             # leading line number (diff/log)
    if re.match(r"^\s*(import|from|const|let|var|function|class|def|#include|\$ |\+ |\- |@@)", t):
        return False
    return True

def is_changelog(t):
    """Reading release notes ('Fixed… Added… Changed…') is not the user debugging."""
    return len(re.findall(r"(?im)^\s*[-*•]?\s*(fixed|added|changed|removed|improved)\b", t or "")) >= 2

def mine_window(window, role, prose):
    """A debug→fix insight = assistant prose announcing a fix, preceded (recently)
    by a real error. Rejects code dumps, changelog reading, and trivia."""
    if role != "assistant": return None
    if fix_score(prose) == 0: return None
    if not is_prose(prose) or is_changelog(prose): return None
    prior = [w for w in window[:-1] if w["had_err"] or w["err"] > 0]
    if not prior: return None
    ctx = max(prior, key=lambda w: w["err"])
    err_txt = denoise(ctx["io"] or ctx["prose"]).strip()
    if not err_txt: return None
    return {
        "kind": "debug-fix",
        "error": oneline(redact(err_txt), 240),
        "fix":   oneline(redact(prose), 240),
        "score": sum(w["err"] for w in window) + fix_score(prose) * 2,
    }

# ---------------------------------------------------------------- taxonomy / tags
# Controlled, REUSED topic vocabulary. The same topic/* tag lands on notes across
# different projects — that overlap is what makes the graph/Dataview useful.
TOPIC_RX = {
    "disk-space":         r"(?i)enospc|no space|disk (is )?full|storage|free up|out of space",
    "dependency-install": r"(?i)\bbun(x)?\b|\bnpm\b|\bpnpm\b|\byarn\b|node_modules|integrity|--ignore-scripts|lockfile|tarball|package manager|\bpip install\b|cargo build",
    "typescript-build":   r"(?i)\btsc\b|typecheck|type error|\bts\d{3,}\b|tsconfig|swiftpm|\bcompile",
    "testing-e2e":        r"(?i)\btests?\b|playwright|vitest|\bjest\b|\be2e\b|\bvite\b|expect\(|coverage|cocotb",
    "git-ci":             r"(?i)\bgit\b|\bmerge\b|rebase|\bPR\b|pull request|workflow|github action|\bCI\b|deploy|\bcommit\b|origin/",
    "native-build":       r"(?i)\bopus\b|node-gyp|python 3|libexpat|\bABI\b|native module|\bgyp\b|electrobun",
    "api-server":         r"(?i)\bapi\b|\bserver\b|sidecar|\bport\b|startup|\blisten\b|endpoint|/health",
    "database":           r"(?i)\bsql\b|postgres|sqlite|migration|pglite|\bschema\b|relation \"",
    "frontend-ui":        r"(?i)\breact\b|component|\bcss\b|tailwind|\bUI\b|frontend|\bbutton\b|\brender\b|dashboard",
    "infra-docker":       r"(?i)docker|container|kubernetes|\bk8s\b|compose|\bnginx\b",
    "blockchain":         r"(?i)solana|ethereum|\bwallet\b|\btoken\b|onchain|smart contract|\bviem\b|web3|\bSOL\b",
    "agent-tooling":      r"(?i)\bskill\b|claude code|\bcodex\b|\bmcp\b|\bhook\b|subagent|obsidian",
}
TOPIC_RX = {k: re.compile(v) for k, v in TOPIC_RX.items()}

UUIDISH = re.compile(r"^[0-9a-f]{6,}(-[0-9a-f]+)*$")
EPHEMERAL = re.compile(r"^(agent|subagent|worktree|task|tmp|run)-?[0-9a-f]{6,}$")
SKIP_DIR = {"worktrees", "workspaces", ".codex-worktrees", "src", "packages", "apps"}
def project_slug(cwd):
    p = cwd or ""
    low = p.lower()
    if not p or p == "(unknown)": return "unknown"
    if low.startswith(("/private/tmp", "/tmp", "/private/var/folders", "/var/folders")):
        return "scratch"                              # ephemeral temp working dirs, not real projects
    if "eliza" in low and "workspace" in low: return "eliza"
    parts = [x for x in p.replace(HOME, "").split("/") if x and x != "~"]
    if not parts: return "home"
    # walk from the deepest component up to the first "real" repo name (skip uuid/hash/ephemeral dirs)
    for name in reversed(parts):
        n = name.lower()
        if UUIDISH.match(n) or EPHEMERAL.match(n) or n in SKIP_DIR:
            continue
        return slug(name, 40) or "home"
    return "subagent"

def topics_for(rec):
    blob = " ".join([rec.get("first_prompt",""), rec.get("last_result",""),
                     " ".join(rec.get("tools",{}).keys()),
                     " ".join((i.get("error","")+" "+i.get("fix","")) for i in rec.get("insights",[]))])
    return sorted(t for t, rx in TOPIC_RX.items() if rx.search(blob))

def scope_tags(rec, general_topics):
    """Depth scope: surface (shallow one-off) / general (cross-project, reusable) / project-specific."""
    tops = set(rec.get("topics", []))
    has_fix = len(rec.get("insights", [])) > 0
    substance = has_fix or rec.get("n_asst", 0) >= 4
    if not substance:
        return ["scope/surface"]                       # shallow one-off / trivial
    tags = ["scope/project-specific"]                  # every substantive session is rooted in a repo
    if tops & general_topics:
        tags.append("scope/general")                   # ...and reusable when its topic spans 2+ projects
    return tags

# ---------------------------------------------------------------- claude parse
def claude_text(content):
    """Flatten Claude message.content -> (prose, io, tool_names, had_error, skills).
    prose = assistant/user narrative (text+thinking); io = tool commands+results;
    skills = names of Skill-tool invocations (for the skills usage audit)."""
    prose, io, tools, had_err, skills = [], [], [], False, []
    if isinstance(content, str):
        return content, "", [], False, []
    if isinstance(content, list):
        for b in content:
            if not isinstance(b, dict): continue
            t = b.get("type")
            if t == "text":
                prose.append(b.get("text", ""))
            elif t == "thinking":
                prose.append(b.get("thinking", ""))
            elif t in ("tool_use", "server_tool_use"):
                tools.append(b.get("name", "tool"))
                inp = b.get("input", {})
                if isinstance(inp, dict):
                    if b.get("name") == "Skill" and inp.get("skill"):
                        skills.append(str(inp["skill"]))
                    if inp.get("command"):
                        io.append("$ " + str(inp.get("command")))
            elif t == "tool_result":
                if b.get("is_error"): had_err = True
                c = b.get("content")
                if isinstance(c, list):
                    for x in c:
                        if isinstance(x, dict) and x.get("type") == "text":
                            io.append(x.get("text", ""))
                elif isinstance(c, str):
                    io.append(c)
    return "\n".join(prose), "\n".join(io), tools, had_err, skills

CMD_RX = re.compile(r"<command-name>\s*(/[A-Za-z0-9:_-]+)")

def parse_claude(path):
    first_user = last_asst = title = last_prompt = ""
    cwd = branch = ts_first = ts_last = version = sid = ""
    n_user = n_asst = n_toolerr = 0
    toolc = collections.Counter()
    skills_used = set()
    insights, window = [], []
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try: o = json.loads(line)
                except Exception: continue
                typ = o.get("type")
                if typ == "ai-title" and o.get("aiTitle"): title = o["aiTitle"]
                elif typ == "last-prompt" and o.get("lastPrompt"): last_prompt = o["lastPrompt"]
                elif typ in ("user", "assistant"):
                    sid = o.get("sessionId", sid)
                    cwd = o.get("cwd", cwd) or cwd
                    branch = o.get("gitBranch", branch) or branch
                    version = o.get("version", version) or version
                    t = o.get("timestamp", "")
                    if t and not ts_first: ts_first = t
                    if t: ts_last = t
                    m = o.get("message", {}) or {}
                    prose, io, tools, had_err, skills = claude_text(m.get("content"))
                    for tn in tools: toolc[tn] += 1
                    for sk in skills: skills_used.add(sk)
                    if had_err: n_toolerr += 1
                    if typ == "user":
                        n_user += 1
                        for cmd in CMD_RX.findall(prose): skills_used.add(cmd)   # slash-command usage
                        clean = prose.strip()
                        if clean and not first_user and not clean.startswith(("<", "[Request interrupted")):
                            first_user = clean
                    else:
                        n_asst += 1
                        if prose.strip(): last_asst = prose
                    # rolling window: track error context (io/tool errors) + fix prose
                    es = min(err_score(io), 6)
                    window.append({"role": typ, "prose": prose, "io": denoise(io),
                                   "err": es + (2 if had_err else 0), "had_err": had_err})
                    if len(window) > 6: window.pop(0)
                    ins = mine_window(window, typ, prose)
                    if ins: insights.append(ins)
    except Exception as e:
        return None
    title = title or oneline(last_prompt or first_user, 80) or os.path.basename(path)
    # dedupe insights (keep top by score)
    seen, uniq = set(), []
    for ins in sorted(insights, key=lambda x: -x["score"]):
        k = ins["fix"][:60]
        if k in seen: continue
        seen.add(k); uniq.append(ins)
    return {
        "tool": "claude", "path": path, "id": sid or os.path.basename(path).replace(".jsonl",""),
        "title": title, "project": cwd or "(unknown)", "branch": branch,
        "started": ts_first, "ended": ts_last, "version": version,
        "n_user": n_user, "n_asst": n_asst, "n_toolerr": n_toolerr,
        "tools": dict(toolc.most_common(12)),
        "skills_used": sorted(skills_used),
        "first_prompt": trunc(redact(first_user), 500),
        "last_result": trunc(redact(last_asst), 700),
        "insights": uniq[:8],
    }

# ---------------------------------------------------------------- codex parse
def codex_text(content):
    if isinstance(content, str): return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                parts.append(b.get("text") or b.get("content") or "")
            else:
                parts.append(str(b))
        return "\n".join(p for p in parts if p)
    return ""

def parse_codex(path, titles):
    sid = cwd = model = ts_first = ts_last = nickname = version = ""
    first_user = last_asst = ""
    n_user = n_asst = n_patch_ok = n_patch_fail = 0
    toolc = collections.Counter()
    insights, window = [], []
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try: o = json.loads(line)
                except Exception: continue
                typ = o.get("type"); p = o.get("payload", {}) or {}
                ts = o.get("timestamp", "")
                if ts and not ts_first: ts_first = ts
                if ts: ts_last = ts
                if typ == "session_meta":
                    sid = p.get("id", sid); cwd = p.get("cwd", cwd) or cwd
                    nickname = p.get("agent_nickname", nickname) or nickname
                    version = p.get("cli_version", version) or version
                elif typ == "turn_context":
                    model = p.get("model", model) or model
                    cwd = p.get("cwd", cwd) or cwd
                elif typ == "event_msg":
                    pt = p.get("type")
                    if pt == "user_message":
                        n_user += 1
                        msg = (p.get("message") or "").strip()
                        if msg and not first_user and not msg.startswith(("<", "{")):
                            first_user = msg
                        window.append({"role": "user", "prose": msg, "io": "", "err": 0, "had_err": False})
                    elif pt == "agent_message":
                        n_asst += 1
                        msg = (p.get("message") or "").strip()
                        if msg: last_asst = msg
                        window.append({"role": "assistant", "prose": msg, "io": "", "err": 0, "had_err": False})
                    elif pt == "task_complete":
                        lm = (p.get("last_agent_message") or "").strip()
                        if lm: last_asst = lm
                    elif pt == "patch_apply_end":
                        ok = p.get("success")
                        if ok: n_patch_ok += 1
                        else:
                            n_patch_fail += 1
                            err = denoise(p.get("stderr") or "")[:400]
                            window.append({"role": "tool", "prose": "", "io": err,
                                           "err": min(err_score(err), 6) + 2, "had_err": True})
                        toolc["patch_apply"] += 1
                    elif pt == "mcp_tool_call_end":
                        toolc["mcp_tool"] += 1
                    elif pt == "web_search_end":
                        toolc["web_search"] += 1
                elif typ == "response_item":
                    pt = p.get("type")
                    if pt == "function_call":
                        toolc[p.get("name", "function")] += 1
                    elif pt == "function_call_output":
                        out = ""
                        ov = p.get("output")
                        if isinstance(ov, dict): out = str(ov.get("content") or ov.get("output") or "")
                        elif isinstance(ov, str): out = ov
                        out = denoise(out)
                        if out.strip() and err_score(out):
                            window.append({"role": "tool", "prose": "", "io": out[:400],
                                           "err": min(err_score(out), 6), "had_err": False})
                    elif pt == "message":
                        txt = codex_text(p.get("content"))
                        if p.get("role") == "user" and txt and not first_user:
                            first_user = txt.strip()
                if len(window) > 6: window.pop(0)
                ins = mine_window(window, window[-1]["role"] if window else "", window[-1]["prose"] if window else "")
                if ins: insights.append(ins)
    except Exception:
        return None
    meta = titles.get(sid, {})
    title = meta.get("thread_name") or oneline(first_user, 80) or os.path.basename(path)
    seen, uniq = set(), []
    for ins in sorted(insights, key=lambda x: -x["score"]):
        k = ins["fix"][:60]
        if k in seen: continue
        seen.add(k); uniq.append(ins)
    return {
        "tool": "codex", "path": path, "id": sid or os.path.basename(path).replace(".jsonl",""),
        "title": title, "project": cwd or "(unknown)", "branch": "",
        "started": ts_first, "ended": meta.get("updated_at") or ts_last, "version": version,
        "model": model, "nickname": nickname,
        "n_user": n_user, "n_asst": n_asst, "n_toolerr": n_patch_fail,
        "n_patch_ok": n_patch_ok,
        "tools": dict(toolc.most_common(12)),
        "first_prompt": trunc(redact(first_user), 500),
        "last_result": trunc(redact(last_asst), 700),
        "insights": uniq[:8],
    }

# ---------------------------------------------------------------- writers
def proj_short(p):
    p = p or "(unknown)"
    return p.replace(HOME, "~")

def note_path_for(rec):
    # Filename keyed on the IMMUTABLE source path (unique per transcript) so notes never
    # collide and never orphan when the mutable ai-title changes. Title lives in H1/frontmatter.
    d = (rec.get("started") or "")[:10] or "undated"
    h = hashlib.sha1(rec["path"].encode()).hexdigest()[:10]
    base = f"{d} {slug(rec['title'],46)} {h}.md"
    sub = slug(proj_short(rec["project"]).replace("~","home").replace("/","-"), 60) or "misc"
    return os.path.join(ROOT, rec["tool"], "sessions", sub, base)

def render_session_note(rec):
    tools_str = ", ".join(f"{k}×{v}" for k, v in rec["tools"].items()) or "—"
    topics = rec.get("topics", [])
    fm = frontmatter({
        "type": "agent-session",
        "tool": rec["tool"],
        "title": rec["title"],
        "session_id": rec["id"],
        "project": rec.get("project_slug", "home"),
        "project_path": proj_short(rec["project"]),
        "started": rec.get("started",""),
        "ended": rec.get("ended",""),
        "turns_user": rec["n_user"],
        "turns_assistant": rec["n_asst"],
        "errors_seen": rec["n_toolerr"],
        "insights": len(rec["insights"]),
        "topics": topics,
        "tags": rec.get("tags", ["agent-session", f"tool/{rec['tool']}"]),
    })
    tagline = " ".join("#" + t for t in rec.get("tags", []))
    body = [fm, "", f"# {rec['title']}", "",
            f"> **{rec['tool']}** · `{proj_short(rec['project'])}` · {fdate(rec.get('started'))} → {fdate(rec.get('ended'))}",
            f"> {rec['n_user']} user / {rec['n_asst']} assistant turns · {rec['n_toolerr']} errors · tools: {tools_str}"]
    if rec.get("model"): body.append(f"> model: `{rec['model']}`")
    body += ["", tagline, "",
             "## First prompt", "", "> " + (rec["first_prompt"].replace("\n","\n> ") or "_(none captured)_"), "",
             "## Final result / outcome", "", (rec["last_result"] or "_(none captured)_"), ""]
    if rec["insights"]:
        body += ["## 🔧 Debugging & fixes mined", ""]
        for i, ins in enumerate(rec["insights"], 1):
            body += [f"**{i}. Problem:** {ins['error'] or '—'}", "", f"**Fix:** {ins['fix'] or '—'}", ""]
    body += ["---", f"*source: `{rec['path'].replace(HOME,'~')}` · captured by Agent Workspaces sync (digest, not verbatim)*", ""]
    return "\n".join(body)

def rel(p):
    return os.path.relpath(p, ROOT)

def vrel(p):
    """Vault-root-relative path (Obsidian resolves slash-paths from vault root)."""
    return os.path.relpath(p, VAULT)

def prune_orphans(known_notes):
    """Remove session notes no longer backed by a state record (stale title-rename
    duplicates, deleted sources). Keeps files==records, makes the system self-healing."""
    removed = 0
    for tool in ("codex", "claude"):
        for p in glob.glob(os.path.join(ROOT, tool, "sessions", "**", "*.md"), recursive=True):
            if p not in known_notes:
                try: os.remove(p); removed += 1
                except OSError: pass
    return removed

def write_tool_index(tool, recs):
    recs = sorted(recs, key=lambda r: r.get("started",""), reverse=True)
    total = len(recs)
    with_ins = sum(1 for r in recs if r["insights"])
    nins = sum(len(r["insights"]) for r in recs)
    lines = [frontmatter({"type":"agent-workspace-index","tool":tool,"sessions":total,"tags":[f"tool/{tool}","moc"]}),
             "", f"# {tool.capitalize()} — Sessions", "",
             f"**{total}** sessions · **{with_ins}** with mined fixes · **{nins}** insight candidates.", "",
             "```dataview", "TABLE started as \"Started\", project as \"Project\", turns_assistant as \"Turns\", errors_seen as \"Errs\", insights as \"Fixes\"",
             f"FROM \"Agent Workspaces/{tool}/sessions\"", "WHERE type = \"agent-session\"", "SORT started DESC", "```", "",
             "_If Dataview isn't installed, the table below is a static fallback._", "",
             "| Date | Title | Project | Turns | Fixes |", "|---|---|---|---|---|"]
    for r in recs[:400]:
        link = "[[" + vrel(note_path_for(r))[:-3] + "|" + oneline(r["title"],60).replace("|","/") + "]]"
        lines.append(f"| {(r.get('started') or '')[:10]} | {link} | `{proj_short(r['project'])}` | {r['n_asst']} | {len(r['insights'])} |")
    if total > 400: lines.append(f"\n_…and {total-400} more (see Dataview table above)._")
    with open(os.path.join(ROOT, tool, f"{tool.capitalize()}.md"), "w") as f:
        f.write("\n".join(lines))

# ---------------------------------------------------------------- clustering (dedup)
# The mined queue is heavily redundant (the same CI/test failure recurs across dozens of
# sessions). A deterministic fingerprint collapses near-identical candidates into ONE
# cluster so the queue shows DISTINCT problems, and so the (paid) synthesizer sees ~50
# patterns instead of ~500 near-dupes. $0, no LLM.
_SIG_STRIP = [
    re.compile(r"0x[0-9a-fA-F]+"),                 # hex addresses
    re.compile(r"\b[0-9a-f]{8,}\b"),               # hashes / uuids / sha
    re.compile(r"\d+"),                            # any number (line numbers, counts, ports)
    re.compile(r"[~./][\w./\-]+"),                 # paths
    re.compile(r"\b[a-zA-Z]:\\[\\\w.\-]+"),        # windows paths
]
_SIG_STOP = set((
    "the a an and or to of in is was were be been for on with that this it its as at by from into "
    "not now run runs running error errors output line lines file files test tests failed fail fix "
    "fixed found check checking found root cause issue problem result null none true false return"
).split())
# Map the many ERROR_RX surface forms onto a small canonical vocabulary so
# 'TypeError' / 'type error' and 'ENOENT' / 'no such file' land in the same bucket.
_ERR_CLASS = [
    (re.compile(r"(?i)enoent|no such file|cannot find|not found|module ?not ?found"), "missing-file-or-module"),
    (re.compile(r"(?i)test(s)? failed|\bFAILED\b|assert|expect\("), "test-failure"),
    (re.compile(r"(?i)typeerror|type error|\bts\d{3,}\b|is not a function|is not defined|undefined"), "type-or-ref-error"),
    (re.compile(r"(?i)enospc|no space|disk (is )?full|out of space"), "disk-space"),
    (re.compile(r"(?i)permission denied|eacces|not permitted"), "permissions"),
    (re.compile(r"(?i)connection refused|timed out|econnrefused|etimedout|502|503|504"), "network-timeout"),
    (re.compile(r"(?i)404|not found"), "http-404"),
    (re.compile(r"(?i)500 internal|internal server error"), "http-500"),
    (re.compile(r"(?i)segmentation fault|panic:|fatal|core dumped|sigsegv"), "crash"),
    (re.compile(r"(?i)npm ERR!|integrity|lockfile|tarball|gyp|node-gyp|install failed"), "dependency-install"),
    (re.compile(r"(?i)does not match required schema|invalid|validation"), "schema-validation"),
    (re.compile(r"(?i)command not found|not recognized"), "command-not-found"),
    (re.compile(r"(?i)traceback|exception|errno|\berror:"), "generic-exception"),
]
def _err_classes(raw):
    return sorted({label for rx, label in _ERR_CLASS if rx.search(raw)})

def err_signature(c):
    """Stable fingerprint that collapses near-identical errors into one cluster.
    Keys on (topic set × canonical error-class set) — the semantic core — NOT on the
    volatile code/log body, so the same class of failure across many sessions groups
    together. Falls back to a token skeleton only when no error class is recognized."""
    raw = denoise(c.get("error", ""))
    topics = ",".join(sorted(c.get("topics", [])))
    classes = _err_classes(raw)
    if classes:
        basis = topics + "|" + "|".join(classes)
    else:                                              # unrecognized: fall back to skeleton
        t = raw.lower()
        for rx in _SIG_STRIP:
            t = rx.sub(" ", t)
        toks = [w for w in re.findall(r"[a-z]{4,}", t) if w not in _SIG_STOP]
        basis = topics + "|skel|" + " ".join(sorted(set(toks), key=lambda w: (-len(w), w))[:5])
    return hashlib.sha1(basis.encode()).hexdigest()[:12]

def cluster_candidates(active):
    """Group active candidates by signature; keep the highest-scoring exemplar per cluster.
    Returns clusters sorted by aggregate (recurrence-weighted) score, highest first."""
    clusters = collections.OrderedDict()
    for c in sorted(active, key=lambda c: -c["score"]):
        sig = err_signature(c)
        cl = clusters.get(sig)
        if cl is None:
            clusters[sig] = {**c, "signature": sig, "cluster_size": 1,
                             "members": [cand_key(c)], "projects": {c["project"]},
                             "agg_score": c["score"]}
        else:
            cl["cluster_size"] += 1
            cl["members"].append(cand_key(c))
            cl["projects"].add(c["project"])
            cl["agg_score"] += c["score"]
    return sorted(clusters.values(), key=lambda x: -x["agg_score"])

def write_insights(all_recs):
    cands = []
    for r in all_recs:
        scopes = [t.split("/",1)[1] for t in r.get("tags",[]) if t.startswith("scope/")]
        for ins in r["insights"]:
            cands.append({**ins, "tool": r["tool"], "session": r["title"],
                          "project": r.get("project_slug","home"), "date": (r.get("started") or "")[:10],
                          "topics": r.get("topics",[]), "scopes": scopes,
                          "note": vrel(note_path_for(r))[:-3]})
    cands.sort(key=lambda c: -c["score"])
    # split: synthesized candidates drop off the ACTIVE queue so the next-highest rise to the top.
    done = load_synth_done()
    active = [c for c in cands if cand_key(c) not in done]
    archived = [c for c in cands if cand_key(c) in done]
    # machine-readable queues
    with open(os.path.join(INSIGHTS, "candidates.jsonl"), "w") as f:           # ACTIVE queue for synthesize.py
        for c in active: f.write(json.dumps(c) + "\n")
    with open(os.path.join(INSIGHTS, "candidates_synthesized.jsonl"), "w") as f:  # archive (provenance / export)
        for c in archived: f.write(json.dumps(c) + "\n")
    # DEDUPED exemplar queue — distinct problems, recurrence-weighted. Consumed by
    # auto_improve.py (autonomous) and synthesize.py (manual) so the paid model sees
    # ~one row per real pattern instead of dozens of near-identical repeats.
    clusters = cluster_candidates(active)
    with open(os.path.join(INSIGHTS, "clusters.jsonl"), "w") as f:
        for cl in clusters:
            f.write(json.dumps({**cl, "projects": sorted(cl["projects"])}) + "\n")
    # human MOC (active only, DEDUPED to distinct problems)
    by_tool = collections.Counter(c["tool"] for c in active)
    by_topic = collections.Counter(t for c in active for t in c["topics"])
    lines = [frontmatter({"type":"insights-index","candidates":len(active),"distinct":len(clusters),
                          "synthesized":len(archived),"tags":["moc","insights"]}),
             "", "# 🔧 Mined Insights — Debugging & Fixes", "",
             f"**{len(clusters)}** distinct problems "
             f"(deduped from {len(active)} raw candidates · {', '.join(f'{k}: {v}' for k,v in by_tool.items()) or '—'})"
             + (f" · ✅ **{len(archived)}** already synthesized → [[Agent Workspaces/_insights/Synthesized|archive]]" if archived else ""), "",
             "**By topic:** " + (" · ".join(f"`#topic/{t}` {n}" for t, n in by_topic.most_common()) or "—"), "",
             "Distinct problems (deduped, recurrence-weighted; highest signal first). `×N` = how many "
             "sessions hit this same pattern — the strongest promote signal. The autonomous loop "
             "(`auto_improve.py`) distills these into skills; once done they move to the archive.", "",
             "| Score | ×N | Topics | Problem → Fix | Projects | Session |", "|---|---|---|---|---|---|"]
    for c in clusters[:200]:
        prob = oneline(c["error"],60).replace("|","/"); fix = oneline(c["fix"],60).replace("|","/")
        link = f"[[{c['note']}|{oneline(c['session'],28).replace('|','/')}]]"
        ttags = " ".join("#topic/"+t for t in c["topics"]) or "—"
        nproj = len(c["projects"])
        projcell = f"`{c['project']}`" + (f" +{nproj-1}" if nproj > 1 else "")
        lines.append(f"| {c['agg_score']} | ×{c['cluster_size']} | {ttags} | **{prob}** → {fix} | {projcell} | {link} |")
    with open(os.path.join(INSIGHTS, "Insights.md"), "w") as f:
        f.write("\n".join(lines))
    # archive view
    alines = [frontmatter({"type":"insights-archive","synthesized":len(archived),"tags":["insights","synthesized"]}),
              "", "# ✅ Synthesized Insights (archive)", "",
              f"**{len(archived)}** candidates already distilled into skills/memories — kept for provenance. "
              "These no longer appear in [[Agent Workspaces/_insights/Insights|the active list]].", "",
              "| Topics | Problem → Fix | Project | Session |", "|---|---|---|---|"]
    for c in archived[:500]:
        prob = oneline(c["error"],62).replace("|","/"); fix = oneline(c["fix"],62).replace("|","/")
        link = f"[[{c['note']}|{oneline(c['session'],30).replace('|','/')}]]"
        ttags = " ".join("#topic/"+t for t in c["topics"]) or "—"
        alines.append(f"| {ttags} | **{prob}** → {fix} | `{c['project']}` | {link} |")
    with open(os.path.join(INSIGHTS, "Synthesized.md"), "w") as f:
        f.write("\n".join(alines))
    return len(active)

def write_tags_moc(recs, topic_projects, general_topics):
    """Tag index: which topics span which projects (the overlaps), with counts + Dataview."""
    topic_counts, proj_counts, scope_counts = collections.Counter(), collections.Counter(), collections.Counter()
    for r in recs:
        proj_counts[r["project_slug"]] += 1
        for t in r["topics"]: topic_counts[t] += 1
        for tag in r["tags"]:
            if tag.startswith("scope/"): scope_counts[tag.split("/",1)[1]] += 1
    lines = [frontmatter({"type":"tags-index","topics":len(topic_projects),
                          "projects":len(proj_counts),"tags":["moc","tags"]}),
             "", "# 🏷️ Tag Index", "",
             "Every session carries `tool/`, `project/`, `topic/`, and `scope/` tags. The **same `topic/*` "
             "tag is reused across projects** — that overlap is what lets you find *“where have I solved this "
             "before”* across your whole history.", "",
             "## Scope (depth)", "", "| Scope | Sessions | Meaning |", "|---|---|---|",
             f"| `#scope/general` | {scope_counts.get('general',0)} | reusable across 2+ projects (skill-worthy) |",
             f"| `#scope/project-specific` | {scope_counts.get('project-specific',0)} | tied to one repo's setup/quirks |",
             f"| `#scope/surface` | {scope_counts.get('surface',0)} | shallow one-off / trivial |", "",
             "## Topics — and the projects they overlap", "",
             "| Topic | Sessions | # Projects | Projects | Cross-project? |", "|---|---|---|---|---|"]
    for t, _ in topic_counts.most_common():
        ps = sorted(topic_projects.get(t, []))
        shown = ", ".join(f"`{p}`" for p in ps[:6]) + ("…" if len(ps) > 6 else "")
        flag = "✅ general" if t in general_topics else "—"
        lines.append(f"| `#topic/{t}` | {topic_counts[t]} | {len(ps)} | {shown} | {flag} |")
    lines += ["", "## Projects", "", "| Project | Sessions |", "|---|---|"]
    for p, n in proj_counts.most_common(50):
        lines.append(f"| `#project/{p}` | {n} |")
    lines += ["", "---", "```dataview",
              "TABLE length(rows) as Sessions FROM #agent-session FLATTEN topics as topic GROUP BY topic SORT length(rows) DESC",
              "```", ""]
    with open(os.path.join(ROOT, "Tags.md"), "w") as f:
        f.write("\n".join(lines))

def write_agents_catalog():
    def listing(sub):
        base = os.path.join(AGENTS, sub)
        items = []
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                if name.startswith("."): continue
                sk = os.path.join(base, name, "SKILL.md")
                desc = ""
                if os.path.isfile(sk):
                    try:
                        with open(sk, errors="replace") as f:
                            for ln in f:
                                if ln.startswith("description:"):
                                    desc = ln.split(":",1)[1].strip().strip('"'); break
                    except Exception: pass
                items.append((name, oneline(desc,120)))
        return items
    skills = listing("skills")
    lines = [frontmatter({"type":"agent-workspace-index","tool":"agents","skills":len(skills),"tags":["tool/agents","moc"]}),
             "", "# Agents — Skill / Rule / Workflow Catalog", "",
             f"`~/.agents` is a **library** (no sessions): **{len(skills)}** skills, plus rules & workflows.", "",
             "## Skills", "", "| Skill | Description |", "|---|---|"]
    for n, d in skills: lines.append(f"| `{n}` | {d} |")
    for sub in ("rules", "workflows"):
        base = os.path.join(AGENTS, sub)
        if os.path.isdir(base):
            entries = [x for x in sorted(os.listdir(base)) if not x.startswith(".")]
            lines += ["", f"## {sub.capitalize()}", "", ", ".join(f"`{e}`" for e in entries) or "_none_"]
    with open(os.path.join(ROOT, "agents", "Agents.md"), "w") as f:
        f.write("\n".join(lines))

def write_context():
    # Codex memories (sanitized copy of the .md memory files)
    mdir = os.path.join(CODEX, "memories")
    if os.path.isdir(mdir):
        chunks = ["# Codex — Captured Memories & Context", "",
                  "_Sanitized copies of `~/.codex/memories/*.md` (read-only source)._", ""]
        for name in ("MEMORY.md", "memory_summary.md", "raw_memories.md"):
            fp = os.path.join(mdir, name)
            if os.path.isfile(fp):
                try:
                    with open(fp, errors="replace") as f: txt = f.read()
                    chunks += [f"## {name}", "", redact(trunc(txt, 8000)), ""]
                except Exception: pass
        with open(os.path.join(ROOT, "codex", "context", "memories.md"), "w") as f:
            f.write("\n".join(chunks))
    # Claude CLAUDE.md
    cm = os.path.join(CLAUDE, "CLAUDE.md")
    if os.path.isfile(cm):
        try:
            with open(cm, errors="replace") as f: txt = f.read()
            with open(os.path.join(ROOT, "claude", "context", "claude-md.md"), "w") as f:
                f.write("# Claude — Global CLAUDE.md (captured)\n\n" + redact(txt))
        except Exception: pass

# ---------------------------------------------------------------- discovery
def load_codex_titles():
    titles = {}
    idx = os.path.join(CODEX, "session_index.jsonl")
    if os.path.isfile(idx):
        with open(idx, errors="replace") as f:
            for line in f:
                try: o = json.loads(line)
                except Exception: continue
                if o.get("id"): titles[o["id"]] = o
    return titles

def discover():
    files = []
    for pat in (os.path.join(CLAUDE, "projects", "**", "*.jsonl"),):
        files += [("claude", p) for p in glob.glob(pat, recursive=True)]
    for pat in (os.path.join(CODEX, "sessions", "**", "*.jsonl"),
                os.path.join(CODEX, "archived_sessions", "*.jsonl")):
        files += [("codex", p) for p in glob.glob(pat, recursive=True)]
    return files

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    os.makedirs(INSIGHTS, exist_ok=True)
    state = {"files": {}}
    if os.path.isfile(STATE_PATH) and not args.full:
        try: state = json.load(open(STATE_PATH))
        except Exception: state = {"files": {}}
    files = discover()
    if args.limit: files = files[:args.limit]
    titles = load_codex_titles()

    # ---- Pass 1: parse (or reuse cached). No note writing yet — tags need a global view. ----
    recs, n_new, n_skip = [], 0, 0
    for tool, path in files:
        try: st = os.stat(path)
        except OSError: continue
        sig = {"mtime": int(st.st_mtime), "size": st.st_size}
        cached = state["files"].get(path)
        if cached and cached.get("mtime") == sig["mtime"] and cached.get("size") == sig["size"] and cached.get("rec"):
            recs.append(cached["rec"]); n_skip += 1; continue
        rec = parse_claude(path) if tool == "claude" else parse_codex(path, titles)
        if not rec: continue
        recs.append(rec); n_new += 1
        ent = state["files"].setdefault(path, {})
        ent.update({**sig, "rec": rec})

    # ---- Pass 2: taxonomy. Compute project + topics, then the cross-project overlap map. ----
    for rec in recs:
        rec["project_slug"] = project_slug(rec.get("project"))
        rec["topics"] = topics_for(rec)
    topic_projects = collections.defaultdict(set)
    for rec in recs:
        for t in rec["topics"]:
            topic_projects[t].add(rec["project_slug"])
    general_topics = {t for t, ps in topic_projects.items() if len(ps) >= 2}  # seen in 2+ projects = reusable
    for rec in recs:
        rec["tags"] = (["agent-session", f"tool/{rec['tool']}", f"project/{rec['project_slug']}"]
                       + [f"topic/{t}" for t in rec["topics"]]
                       + scope_tags(rec, general_topics)
                       + (["has-fix"] if rec["insights"] else []))

    if args.dry_run:
        ni = sum(len(r["insights"]) for r in recs)
        print(f"[dry-run] {len(recs)} sessions ({n_new} new, {n_skip} cached) · {ni} insight candidates")
        print("   projects:", len({r["project_slug"] for r in recs}),
              "· topics:", len(topic_projects), "· cross-project(general):", sorted(general_topics))
        return

    # ---- Pass 3: write notes, incremental via content hash (only rewrite when changed). ----
    n_written = 0
    for rec in recs:
        ent = state["files"].setdefault(rec["path"], {})
        body = render_session_note(rec)
        bsig = hashlib.sha1(body.encode("utf-8", "replace")).hexdigest()
        new_note = note_path_for(rec); old_note = ent.get("note")
        if not (ent.get("notesig") == bsig and old_note == new_note and os.path.isfile(new_note)):
            if old_note and old_note != new_note and os.path.isfile(old_note):
                try: os.remove(old_note)          # title changed -> drop stale note, don't orphan it
                except OSError: pass
            os.makedirs(os.path.dirname(new_note), exist_ok=True)
            with open(new_note, "w") as f: f.write(body)
            n_written += 1
        ent["note"] = new_note; ent["notesig"] = bsig; ent["rec"] = rec

    # Prune stale notes — but NEVER on a partial run (--limit) or a suspicious under-count,
    # or we'd delete the archive this system exists to protect.
    n_pruned = 0
    if not args.limit:
        known = {state["files"][r["path"]].get("note") for r in recs}
        on_disk = sum(len(glob.glob(os.path.join(ROOT, t, "sessions", "**", "*.md"), recursive=True))
                      for t in ("codex", "claude"))
        if len(known) >= on_disk * 0.5:
            n_pruned = prune_orphans(known)
        else:
            print(f"[sync] prune SKIPPED (safety): {len(known)} records vs {on_disk} notes on disk")

    by_tool = collections.defaultdict(list)
    for r in recs: by_tool[r["tool"]].append(r)
    for tool in ("codex", "claude"):
        write_tool_index(tool, by_tool.get(tool, []))
    write_agents_catalog()
    write_context()
    ncand = write_insights(recs)
    write_tags_moc(recs, topic_projects, general_topics)

    state["generated_at"] = fdate(datetime.datetime.now(datetime.timezone.utc).isoformat())
    state["counts"] = {"sessions": len(recs), "candidates": ncand,
                       "codex": len(by_tool.get("codex",[])), "claude": len(by_tool.get("claude",[])),
                       "projects": len({r["project_slug"] for r in recs}), "topics": len(topic_projects)}
    json.dump(state, open(STATE_PATH, "w"))
    print(f"[sync] {len(recs)} sessions ({n_new} new, {n_skip} cached, {n_written} written, {n_pruned} pruned) · {ncand} candidates")
    print(f"[sync] codex={state['counts']['codex']} claude={state['counts']['claude']} "
          f"· {state['counts']['projects']} projects · {state['counts']['topics']} topics "
          f"· {len(general_topics)} cross-project")

if __name__ == "__main__":
    main()
