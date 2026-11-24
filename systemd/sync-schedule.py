#!/usr/bin/env python3
"""Apply schedule.json from GJV_Review main to the VM's GJV refresh timer.

Copied from hb-pulse-trial-balance/systemd/sync-schedule.py.

Shirish 2026-11-09: put the schedule on GitHub so Rohit can change it whenever required
(the same as the cash flow report). Rohit edits schedule.json on main; the hourly user
timer hb-gjv-register-schedule.timer runs this, so a change is live within the hour. The
refresh timer itself stays on the VM, because the refresh needs the Databricks connector
that only this box has.

The times go into a drop-in, hb-gjv-register.timer.d/schedule.conf, which overrides
OnCalendar in the unit file. Nothing happens when the schedule is unchanged. The timer is
Persistent=false, so moving it cannot cause a catch-up run; the stamp is touched anyway
in case that is ever changed.

A file that cannot be applied keeps the last good schedule and mails Rohit once per bad
version, from pulse.
  SCHEDULE_FILE=path  read a local file instead of GitHub (testing)
  DRY_RUN=1           print what would be written, touch nothing, send nothing
"""
import hashlib, json, os, re, subprocess, sys, tempfile, html
from pathlib import Path

REPO = "rohit75227/GJV_Review"
SECTION = "gjv_register_refresh"
TIMER = "hb-gjv-register.timer"
UNIT_DIR = Path.home() / ".config/systemd/user"
DROPIN = UNIT_DIR / f"{TIMER}.d" / "schedule.conf"
STAMP = Path.home() / f".local/share/systemd/timers/stamp-{TIMER}"
STATE = Path(__file__).resolve().parent.parent / ".schedule-sync.state"
MAIL_TO = "rohit.jain@hudabeauty.com"
SEND_MAIL = "/home/azureuser/agents/reconcile-uae/graph/send_mail.py"
GRAPH_CONFIG = "/home/azureuser/agents/reconcile-uae/graph/graph_config.pulse.json"
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
DRY = bool(os.environ.get("DRY_RUN"))


def fetch():
    local = os.environ.get("SCHEDULE_FILE")
    if local:
        return Path(local).read_text()
    r = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github.raw",
                        f"repos/{REPO}/contents/schedule.json?ref=main"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        if "404" in r.stderr or "Not Found" in r.stdout + r.stderr:
            return None
        raise RuntimeError("could not read schedule.json from GitHub: " + r.stderr.strip())
    return r.stdout


def oncalendar(text):
    """Return the OnCalendar lines, or raise ValueError in words Rohit can act on."""
    try:
        cfg = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"schedule.json is not valid JSON (line {e.lineno}: {e.msg}). "
                         "Check for a missing comma or quote.")
    job = cfg.get(SECTION)
    if not isinstance(job, dict):
        raise ValueError(f'schedule.json needs a "{SECTION}" section.')
    times = job.get("times_dubai")
    if isinstance(times, str):
        times = [times]
    if not times or not isinstance(times, list):
        raise ValueError('"times_dubai" must list at least one time, for example ["09:00", "17:00"].')
    for t in times:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(t).strip())
        if not m or int(m[1]) > 23 or int(m[2]) > 59:
            raise ValueError(f'"{t}" is not a time. Use 24 hour HH:MM, for example "09:00" or "17:30".')
    days = job.get("days", "every day")
    if isinstance(days, str) and days.strip().lower() in ("every day", "daily", "all"):
        prefix = ""
    else:
        if isinstance(days, str):
            days = [d.strip() for d in days.split(",")]
        if not isinstance(days, list) or not days:
            raise ValueError('"days" must be "every day" or a list such as ["Mon", "Tue"].')
        norm = []
        for d in days:
            d3 = str(d).strip()[:3].title()
            if d3 not in DAYS:
                raise ValueError(f'"{d}" is not a day. Use Mon, Tue, Wed, Thu, Fri, Sat or Sun.')
            norm.append(d3)
        prefix = ",".join(sorted(set(norm), key=DAYS.index)) + " "
    lines = []
    for t in sorted(set(str(t).strip().zfill(5) for t in times)):
        h, mi = t.split(":")
        lines.append(f"{prefix}*-*-* {int(h):02d}:{mi}:00 Asia/Dubai")
    for ln in lines:  # systemd has the last word on what it accepts
        r = subprocess.run(["systemd-analyze", "calendar", ln], capture_output=True, text=True)
        if r.returncode != 0:
            raise ValueError(f"systemd does not accept the schedule {ln!r}: {r.stderr.strip()}")
    return lines


def report_once(text, msg):
    """Mail Rohit the first time a given broken file is seen; stay quiet after."""
    h = hashlib.sha256((text or "").encode()).hexdigest()
    seen = STATE.read_text().strip() if STATE.exists() else ""
    print("schedule.json invalid: " + msg)
    if seen == "bad " + h or DRY:
        return
    body = (f"<p>The GJV Journal Register refresh schedule in schedule.json on GJV_Review "
            f"main could not be applied:</p><p><b>{html.escape(msg)}</b></p>"
            "<p>The refresh keeps its previous schedule until the file is fixed. Edit it at "
            f"https://github.com/{REPO}/blob/main/schedule.json and the fix is picked up "
            "within the hour.</p>")
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as fh:
        fh.write(body)
    import datetime
    r = subprocess.run(["python3", SEND_MAIL, "--to", MAIL_TO, "--subject",
                        f"Trial balance schedule not applied {datetime.date.today()}",
                        "--html-file", fh.name],
                       env={**os.environ, "GRAPH_CONFIG": GRAPH_CONFIG})
    os.unlink(fh.name)
    if r.returncode == 0:
        STATE.write_text("bad " + h + "\n")  # only marked reported once the mail went


def sc(*args):
    subprocess.run(["systemctl", "--user", *args], check=True)


def main():
    text = fetch()
    if text is None:
        print("no schedule.json on main; timer left as it is")
        return 0
    try:
        lines = oncalendar(text)
    except ValueError as e:
        report_once(text, str(e))
        return 0
    body = ("# Written by systemd/sync-schedule.py from schedule.json on GJV_Review main.\n"
            "# Do not edit here: change schedule.json on GitHub and it is applied within the hour.\n"
            "[Timer]\nOnCalendar=\n" + "".join(f"OnCalendar={ln}\n" for ln in lines))
    if DROPIN.exists() and DROPIN.read_text() == body:
        if not DRY and STATE.exists():
            STATE.unlink()  # a fixed file clears the "already reported" marker
        return 0
    if DRY:
        print(f"would write {DROPIN}:\n{body}")
        return 0
    sc("stop", TIMER)
    try:
        DROPIN.parent.mkdir(parents=True, exist_ok=True)
        DROPIN.write_text(body)
        sc("daemon-reload")
        STAMP.parent.mkdir(parents=True, exist_ok=True)
        STAMP.touch()
    finally:
        sc("start", TIMER)
    if STATE.exists():
        STATE.unlink()
    nxt = subprocess.run(["systemctl", "--user", "list-timers", TIMER, "--no-pager"],
                         capture_output=True, text=True).stdout.splitlines()
    print("schedule applied: " + "; ".join(lines))
    print(nxt[1] if len(nxt) > 1 else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
