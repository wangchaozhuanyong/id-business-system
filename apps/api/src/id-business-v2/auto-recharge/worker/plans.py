"""内部套餐选择与本轮官网实际观察到的建单标识；价格始终来自结算页。"""
from __future__ import annotations

import re

from checkout_core import Stop

PLANS = {
    "plus": {"label": "Plus", "family": "plus", "tier": None, "official_name": "chatgptplusplan"},
    "pro-5x": {"label": "Pro 5×", "family": "pro", "tier": 5, "official_name": "chatgptprolite"},
    "pro-20x": {"label": "Pro 20×", "family": "pro", "tier": 20, "official_name": "chatgptpro"},
}


def plan_spec(plan):
    if not isinstance(plan, str) or plan not in PLANS:
        raise Stop("unsupported_target_plan")
    return PLANS[plan]


def checkout_text_plan(text):
    """只识别报价页明确标题/档位，不根据金额或用户的期望值推断倍数。"""
    pro = bool(re.search(r"\b(?:ChatGPT\s+)?Pro\b", text, re.I))
    if pro:
        values = text_tiers(text)
        return ("pro-" + str(values.pop()) + "x") if len(values) == 1 else "pro"
    return "plus" if re.search(r"\b(?:ChatGPT\s+)?Plus\b", text, re.I) else None


def text_tiers(text):
    tiers = re.findall(r"(?<!\d)(5|20)\s*(?:x(?![a-z0-9])|×)|(?<!\d)(5|20)\s*倍", text, re.I)
    return {int(a or b) for a, b in tiers}


def subscription_match(target_plan, current_plan, current_tier=None):
    spec = plan_spec(target_plan)
    if current_plan != spec["family"]:
        return "target_not_verified" if current_plan else "not_verified"
    if spec["tier"] is None:
        return "matched"
    if current_tier is None:
        return "tier_not_verified"
    return "matched" if current_tier == spec["tier"] else "target_not_verified"
