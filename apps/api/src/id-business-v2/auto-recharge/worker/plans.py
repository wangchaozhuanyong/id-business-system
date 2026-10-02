"""内部套餐选择与已核对的官网建单标识；价格始终来自结算页。"""
from __future__ import annotations

import re

from checkout_core import Stop

PLANS = {
    "plus": {"label": "Plus", "family": "plus", "tier": None, "official_name": "chatgptplusplan"},
    "pro-5x": {"label": "Pro（标准）", "family": "pro", "tier": 5, "official_name": "chatgptprolite"},
    "pro-20x": {"label": "Pro（更多使用额度）", "family": "pro", "tier": 20, "official_name": "chatgptpro"},
    "pro-500": {"label": "Pro（最高使用额度）", "family": "promax", "tier": None, "official_name": "chatgptpromax"},
}

# 官网公开定价组件将 Pro 100/200/500 分别映射为 prolite/pro/promax；不推算使用倍数。
PRO_PRICE_PLANS = {100: "pro-5x", 200: "pro-20x", 500: "pro-500"}
PRO_GROUP = re.compile(r"^\s*(?:Choose Pro plan tier|选择\s*Pro\s*套餐档位|(?:ChatGPT\s*)?Pro(?:\s*plan|\s*套餐)?)\s*$", re.I)
PRO_USAGE_LABELS = {"pro-5x": r"Standard|标准", "pro-20x": r"More usage|更多使用额度",
                    "pro-500": r"Max usage|最高使用额度"}


def selection_spec(plan):
    spec = plan_spec(plan)
    return {**spec, "price_usd": next((price for price, key in PRO_PRICE_PLANS.items()
                                      if key == plan), None)}


def plan_spec(plan):
    if not isinstance(plan, str) or plan not in PLANS:
        raise Stop("unsupported_target_plan")
    return PLANS[plan]


def checkout_text_plan(text):
    """只识别报价页明确标题/档位，不根据金额或用户的期望值推断倍数。"""
    pro = bool(re.search(r"\b(?:ChatGPT\s+)?Pro\b", text, re.I))
    if pro:
        values = text_tiers(text)
        # 只接受名称明确的 Pro 100/200/500，不把今日应付或续费金额当套餐标识。
        prices = set(re.findall(r"^\s*(?:ChatGPT\s+)?Pro\s+(100|200|500)\s*$", text, re.I | re.M))
        if prices:
            named = {PRO_PRICE_PLANS[int(price)] for price in prices}
            if len(named) != 1 or len(values) > 1:
                return "pro"
            plan = named.pop()
            if values and (plan not in PLANS or PLANS[plan]["tier"] not in values):
                return "pro"
            return plan
        return ("pro-" + str(values.pop()) + "x") if len(values) == 1 else "pro"
    return "plus" if re.search(r"\b(?:ChatGPT\s+)?Plus\b", text, re.I) else None


def text_tiers(text):
    tiers = re.findall(r"(?<!\d)(5|20)\s*(?:x(?![a-z0-9])|×)|(?<!\d)(5|20)\s*倍", text, re.I)
    return {int(a or b) for a, b in tiers}


def checkout_option_plan(label):
    """仅在已确认的 Pro 档位组内识别官网 Standard/More usage/Max usage 文案。"""
    patterns = {"pro-5x": r"(?:Standard|标准)",
                "pro-20x": r"(?:More usage|更多使用额度)",
                "pro-500": r"(?:Max usage|最高使用额度)"}
    matches = [plan for plan, title in patterns.items()
               if re.search(rf"(?:^|\n)\s*{title}\s*$", label, re.I)]
    tiers = text_tiers(label)
    if len(tiers) > 1:
        return None
    matches.extend(f'pro-{tier}x' for tier in tiers)
    prices = re.findall(r'^\s*(?:ChatGPT\s+)?Pro\s+(100|200|500)\s*$', label, re.I | re.M)
    matches.extend(PRO_PRICE_PLANS[int(price)] for price in prices)
    return matches[0] if len(set(matches)) == 1 else None


def subscription_match(target_plan, current_plan, current_tier=None):
    spec = plan_spec(target_plan)
    if current_plan != spec["family"]:
        return "target_not_verified" if current_plan else "not_verified"
    if spec["tier"] is None:
        return "matched"
    if current_tier is None:
        return "tier_not_verified"
    return "matched" if current_tier == spec["tier"] else "target_not_verified"
