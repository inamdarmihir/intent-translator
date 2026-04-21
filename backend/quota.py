"""
quota.py — Persistent monthly Firecrawl page usage tracker.

Free tier = 500 pages/month.
Default hard cap = 400 pages/month (leaves 100 buffer).
Resets automatically on the 1st of each calendar month.
"""

import json
import os
import time
from datetime import datetime
from pathlib import Path

QUOTA_FILE = Path(__file__).parent / "firecrawl_quota.json"
DEFAULT_MONTHLY_CAP = int(os.getenv("FIRECRAWL_MONTHLY_CAP", "400"))


def _current_month() -> str:
    return datetime.utcnow().strftime("%Y-%m")


def _load() -> dict:
    if not QUOTA_FILE.exists():
        return {"month": _current_month(), "pages_used": 0, "cap": DEFAULT_MONTHLY_CAP}
    try:
        data = json.loads(QUOTA_FILE.read_text())
        # Auto-reset on new month
        if data.get("month") != _current_month():
            data = {"month": _current_month(), "pages_used": 0, "cap": data.get("cap", DEFAULT_MONTHLY_CAP)}
            _save(data)
        return data
    except Exception:
        return {"month": _current_month(), "pages_used": 0, "cap": DEFAULT_MONTHLY_CAP}


def _save(data: dict) -> None:
    QUOTA_FILE.write_text(json.dumps(data, indent=2))


def get_quota() -> dict:
    """Return current quota state."""
    data = _load()
    return {
        "month": data["month"],
        "pages_used": data["pages_used"],
        "cap": data["cap"],
        "remaining": max(0, data["cap"] - data["pages_used"]),
        "percent_used": round(data["pages_used"] / data["cap"] * 100, 1) if data["cap"] else 0,
        "exhausted": data["pages_used"] >= data["cap"],
    }


def consume(pages: int) -> dict:
    """
    Record that `pages` pages were crawled.
    Returns updated quota state.
    Raises QuotaExhausted if over cap.
    """
    data = _load()
    if data["pages_used"] + pages > data["cap"]:
        raise QuotaExhausted(
            used=data["pages_used"],
            cap=data["cap"],
            requested=pages,
        )
    data["pages_used"] += pages
    _save(data)
    return get_quota()


def can_crawl(pages: int = 1) -> bool:
    """Check if we have quota for `pages` more pages."""
    data = _load()
    return data["pages_used"] + pages <= data["cap"]


def remaining_pages() -> int:
    data = _load()
    return max(0, data["cap"] - data["pages_used"])


def set_cap(new_cap: int) -> dict:
    """Update the monthly cap (persisted)."""
    data = _load()
    data["cap"] = new_cap
    _save(data)
    return get_quota()


def reset_quota() -> dict:
    """Manual reset (useful for testing)."""
    data = {"month": _current_month(), "pages_used": 0, "cap": DEFAULT_MONTHLY_CAP}
    _save(data)
    return get_quota()


class QuotaExhausted(Exception):
    def __init__(self, used: int, cap: int, requested: int):
        self.used = used
        self.cap = cap
        self.requested = requested
        super().__init__(
            f"Firecrawl quota exhausted: {used}/{cap} pages used this month. "
            f"Requested {requested} more. Resets on the 1st of next month."
        )
