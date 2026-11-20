"""MkDocs hooks for the self-hosted documentation site.

The documents link to files outside docs/ (contracts, playbooks, alert rules, scripts...). Those
links would be broken on the site, so this hook points them at /_source/<path in the repository>
and copies the files there when the site is built; nginx serves them as plain text (directories
with an index). The site therefore works without internet access or a Git server.
"""
import os
import re
import shutil

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LINK = re.compile(r"(\]\()([^)\s]+)(\))")
MAX_FILE = 2 * 1024 * 1024
SKIP_DIRS = {".git", "node_modules", "target", "remix-live", "state", "__pycache__"}
SKIP_NAMES = {".env"}  # exact names: .env.example is documentation, .env holds secrets
wanted = set()


def _outside_target(page_src, target):
    """Repository path of a link that leaves docs/, or None."""
    if re.match(r"^[a-z]+:", target) or target.startswith(("#", "/")):
        return None
    path, _, _ = target.partition("#")
    if not path:
        return None
    resolved = os.path.normpath(os.path.join(os.path.dirname(page_src), path))
    docs = os.path.join(REPO, "docs")
    if resolved == docs or resolved.startswith(docs + os.sep):
        return None
    if not resolved.startswith(REPO + os.sep) or not os.path.exists(resolved):
        return None
    rel = os.path.relpath(resolved, REPO)
    if any(part in SKIP_DIRS for part in rel.split(os.sep)) or os.path.basename(rel) in SKIP_NAMES:
        return None
    return rel


def on_page_markdown(markdown, page, config, files):
    def fix(match):
        rel = _outside_target(page.file.abs_src_path, match.group(2))
        if rel is None:
            return match.group(0)
        wanted.add(rel)
        suffix = "/" if os.path.isdir(os.path.join(REPO, rel)) else ""
        return f"{match.group(1)}/_source/{rel}{suffix}{match.group(3)}"

    out, fence = [], False
    for line in markdown.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
        out.append(line if fence else LINK.sub(fix, line))
    return "\n".join(out)


def _copy_file(src, dst):
    if os.path.getsize(src) > MAX_FILE or os.path.basename(src) in SKIP_NAMES:
        return
    try:
        with open(src, "rb") as f:
            if b"\0" in f.read(8192):
                return  # binary
    except OSError:
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)


def on_post_build(config):
    root = os.path.join(config["site_dir"], "_source")
    for rel in sorted(wanted):
        src = os.path.join(REPO, rel)
        dst = os.path.join(root, rel)
        if os.path.isdir(src):
            for dirpath, dirnames, filenames in os.walk(src):
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
                for name in filenames:
                    s = os.path.join(dirpath, name)
                    _copy_file(s, os.path.join(dst, os.path.relpath(s, src)))
        else:
            _copy_file(src, dst)
