"""内部套餐选择与已核对的官网建单标识；价格始终来自结算页。"""
from __future__ import annotations

import re

from checkout_core import Stop, account_plan

PLANS = {
    # 官网公开脚本 PlanName.GO（2026-10-03）；不采用合作方或免费赠送套餐标识。
    "go": {"label": "Go", "family": "go", "tier": None, "official_name": "chatgptgoplan"},
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
    if re.search(r"^\s*(?:ChatGPT\s+)?Go\s*$", text, re.I | re.M):
        # 同页存在其他个人套餐标题时不能确认 Go；正文中的 go 动词不是套餐标题。
        if re.search(r"^\s*(?:ChatGPT\s+)?(?:Plus|Pro)(?:\s.*)?$", text, re.I | re.M):
            return None
        return "go"
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


def subscription_transition(current_plan, target_plan):
    """只选择潜在的开通/升级路径；升级必须继续核实官网入口与报价。"""
    spec = plan_spec(target_plan)
    if current_plan == "free":
        return "new_subscription"
    if current_plan == "go" and target_plan == "plus":
        return "subscription_upgrade"
    if current_plan == "plus" and spec["family"] in {"pro", "promax"}:
        return "subscription_upgrade"
    raise Stop("incompatible_existing_subscription", current_plan=current_plan)


def official_subscription(data, account_id):
    """官网明确 prolite/pro/promax 标识对应档位，不按付款金额推算。"""
    accounts = data.get("accounts") if isinstance(data, dict) else None
    node = accounts.get(account_id) if isinstance(accounts, dict) else None
    account = node.get("account") if isinstance(node, dict) else None
    raw_plan = (account.get("plan_type") or node.get("plan_type")) if isinstance(account, dict) else None
    if raw_plan == "prolite":
        # account_plan 继续校验同账户形状及 ID；只规范官网已确认的 Pro Lite 枚举。
        normalized = {**data, "accounts": {**accounts, account_id: {**node,
                      "plan_type": "pro", "account": {**account, "plan_type": "pro"}}}}
        plan = account_plan(normalized, account_id)
    else:
        plan = account_plan(data, account_id)
    return {"current_plan": plan,
            "current_tier": 5 if raw_plan == "prolite" else 20 if raw_plan == "pro" else None}


def subscription_match(target_plan, current_plan, current_tier=None):
    spec = plan_spec(target_plan)
    if current_plan != spec["family"]:
        return "target_not_verified" if current_plan else "not_verified"
    if spec["tier"] is None:
        return "matched"
    if current_tier is None:
        return "tier_not_verified"
    return "matched" if current_tier == spec["tier"] else "target_not_verified"
