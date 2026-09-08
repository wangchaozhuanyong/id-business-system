"""只在官网当前结算表单中填写本次授权资料；不保存完整卡号或安全码。"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import re
import time
from urllib.parse import urlsplit

from checkout_core import Stop

ADDRESS_FIELDS = {
    "name": "input[autocomplete~='name'], input[autocomplete='cc-name']",
    "email": "input[autocomplete~='email']",
    "country": "select[autocomplete~='country'], select[autocomplete~='country-name']",
    "line1": "input[autocomplete~='address-line1'], input[autocomplete~='street-address']",
    "line2": "input[autocomplete~='address-line2']",
    "city": "input[autocomplete~='address-level2']",
    "state": "input[autocomplete~='address-level1'], select[autocomplete~='address-level1']",
    "postal_code": "input[autocomplete~='postal-code']",
}


@dataclass
class PaymentDetails:
    number: str = field(repr=False)
    expiry: str = field(repr=False)
    cvc: str = field(repr=False)
    name: str = field(repr=False)
    email: str = field(repr=False)
    country: str = field(repr=False)
    line1: str = field(repr=False)
    line2: str = field(repr=False)
    city: str = field(repr=False)
    state: str = field(repr=False)
    postal_code: str = field(repr=False)

    @property
    def last4(self):
        return self.number[-4:]

    def clear(self):
        # 清除本对象引用；Python 不承诺物理内存擦除，进程结束销毁临时上下文。
        for key in self.__dataclass_fields__:
            setattr(self, key, "")


def validate_details(details, now=None):
    number = re.sub(r"[ -]", "", details.number)
    # 卡组织和信用卡／借记卡属性由官网支付页判断；本地只做通用 PAN 格式与 Luhn 校验。
    if not re.fullmatch(r"\d{13,19}", number):
        raise Stop("bank_card_number_invalid")
    digits = [int(x) for x in number]
    total = sum((n * 2 - 9 if n * 2 > 9 else n * 2) if i % 2 else n
                for i, n in enumerate(reversed(digits)))
    if total % 10:
        raise Stop("bank_card_number_invalid")
    exp = re.fullmatch(r"(0[1-9]|1[0-2])\s*/\s*(\d{2})", details.expiry)
    if not exp or not re.fullmatch(r"\d{3,4}", details.cvc):
        raise Stop("card_expiry_or_cvc_invalid")
    now = now or datetime.now(timezone.utc)
    if (2000 + int(exp[2]), int(exp[1])) < (now.year, now.month):
        raise Stop("card_expired")
    for key in ("name", "email", "country", "line1", "city", "postal_code"):
        if not getattr(details, key).strip():
            raise Stop("billing_field_required", field=key)
    for key in details.__dataclass_fields__:
        value = getattr(details, key)
        if len(value) > 254 or re.search(r"[\x00-\x1f\x7f]", value):
            raise Stop("invalid_payment_field", field=key)
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", details.email):
        raise Stop("billing_email_invalid")
    if not re.fullmatch(r"[A-Za-z]{2}", details.country):
        raise Stop("billing_country_invalid")
    details.number = number
    details.expiry = exp[1] + "/" + exp[2]
    details.country = details.country.upper()
    return details


def trusted_frames(page):
    # 不把 PAN 填进不明嵌套 frame；仅接受本轮实际观察到的官网和 Stripe 表单源。
    return [f for f in page.frames if urlsplit(f.url).scheme == "https"
            and urlsplit(f.url).hostname in {"chatgpt.com", "js.stripe.com"}]


async def visible_fields(page, selector, scope=None):
    found = []
    for frame in ([scope] if scope is not None else trusted_frames(page)):
        try:
            loc = frame.locator(selector).filter(visible=True)
            for index in range(await loc.count()):
                found.append(loc.nth(index))
        except Exception:
            continue
    return found


async def one_field(page, selector, *, required=True, timeout=15):
    end = time.monotonic() + timeout
    while True:
        nodes = await visible_fields(page, selector)
        if len(nodes) == 1:
            return nodes[0]
        if len(nodes) > 1:
            raise Stop("ambiguous_official_payment_field")
        if not required or time.monotonic() >= end:
            if required:
                raise Stop("official_payment_field_not_ready")
            return None
        await asyncio.sleep(.2)


async def one_billing_field(page, field_name, selector, value, settle_timeout=2, scope=None):
    end = time.monotonic() + settle_timeout
    while True:
        nodes = await visible_fields(page, selector, scope)
        if len(nodes) <= 1:
            return nodes[0] if nodes else None
        # Stripe 切换国家后可能同时保留州文本框和州下拉框。只在官方选项精确匹配时选择下拉框。
        if field_name == "state" and value.strip():
            expected = value.strip().casefold()
            matching = []
            try:
                for node in nodes:
                    if await node.evaluate("n=>n.tagName") != "SELECT":
                        continue
                    options = await node.locator("option").evaluate_all(
                        "ns=>ns.map(n=>({value:n.value,label:n.textContent||''}))")
                    if any(expected in (option["value"].strip().casefold(), option["label"].strip().casefold())
                           for option in options):
                        matching.append(node)
            except Exception:
                matching = []  # iframe 正在替换时等待下一次受控观察。
            if len(matching) == 1:
                return matching[0]
        # 卡片校验后 Stripe 会短暂保留新旧账单 iframe；只等待其自行收敛，绝不在重复控件中猜选。
        if time.monotonic() >= end:
            raise Stop("ambiguous_official_payment_field")
        await asyncio.sleep(.2)


async def billing_frame(page, country, timeout=5):
    """选择国家后 Stripe 会短暂保留旧 iframe；后续账单字段只能在国家值一致的唯一 iframe 中操作。"""
    expected = country.strip().upper()
    end = time.monotonic() + timeout
    while True:
        matching = []
        for frame in trusted_frames(page):
            try:
                countries = frame.locator(ADDRESS_FIELDS["country"]).filter(visible=True)
                values = [await countries.nth(index).input_value() for index in range(await countries.count())]
                if any(value.strip().upper() == expected for value in values):
                    matching.append(frame)
            except Exception:
                continue
        if len(matching) == 1:
            return matching[0]
        if time.monotonic() >= end:
            raise Stop("ambiguous_official_payment_field")
        await asyncio.sleep(.2)


async def fill_billing_node(node, value):
    if await node.evaluate("n=>n.tagName") == "SELECT":
        values = await node.locator("option").evaluate_all("ns=>ns.map(n=>n.value)")
        if value in values:
            await node.select_option(value=value)
        else:
            await node.select_option(label=value)
    else:
        await node.fill(value)


async def reject_external_billing_fields(page, scope):
    """Stripe 无国家值的旧 iframe 可等待消失；主页新增账单字段仍属表单变更。"""
    for frame in trusted_frames(page):
        if frame == scope or urlsplit(frame.url).hostname != "chatgpt.com":
            continue
        for selector in ADDRESS_FIELDS.values():
            if await frame.locator(selector).filter(visible=True).count():
                raise Stop("billing_fields_changed")


async def fill_official_form(page, details):
    validate_details(details)
    # 三个 autocomplete 已在当前官方 Stripe iframe 中实测；不依赖动态 iframe 名称。
    for selector, value in (("input[autocomplete='cc-number']", details.number),
                            ("input[autocomplete='cc-exp']", details.expiry),
                            ("input[autocomplete='cc-csc']", details.cvc)):
        node = await one_field(page, selector)
        await node.fill(value)

    filled, scope = [], None
    country_selector = ADDRESS_FIELDS["country"]
    country = await one_billing_field(page, "country", country_selector, details.country)
    if country is not None:
        await fill_billing_node(country, details.country)
        filled.append("country")
        scope = await billing_frame(page, details.country)
    for field_name, selector in ADDRESS_FIELDS.items():
        if field_name == "country":
            continue
        value = getattr(details, field_name)
        node = await one_billing_field(page, field_name, selector, value, scope=scope)
        if node is None:
            continue  # 官网没有要求该字段时，不伪造网页请求添加字段。
        await fill_billing_node(node, value)
        filled.append(field_name)
    # 已观察的自愿跨次保存选项保持不选；订阅自身续费条款在最终确认中单独展示。
    save = await one_field(page, "input[name='savePayment']", required=False)
    if save and await save.is_checked():
        await save.uncheck()
    # 如果官方明确询问代理身份，按事实申明；不规避验证或冒充人工。
    for frame in trusted_frames(page):
        agent = frame.get_by_label("I am an AI agent acting on behalf of someone else", exact=True)
        if await agent.count() == 1 and await agent.is_visible():
            await agent.check()
    return {"card_fields_filled": True, "billing_fields_filled": filled,
            "billing_fields_not_requested": [k for k in ADDRESS_FIELDS if k not in filled]}


async def verify_card_fields(page, details):
    for selector, expected in (("input[autocomplete='cc-number']", details.number),
                               ("input[autocomplete='cc-exp']", details.expiry),
                               ("input[autocomplete='cc-csc']", details.cvc)):
        node = await one_field(page, selector)
        actual = await node.input_value()
        if re.sub(r"\D", "", actual) != re.sub(r"\D", "", expected):
            raise Stop("payment_form_changed")


async def verify_billing_fields(page, details, filled):
    scope = await billing_frame(page, details.country) if "country" in filled else None
    if scope is not None:
        await reject_external_billing_fields(page, scope)
    for name, selector in ADDRESS_FIELDS.items():
        node = await one_billing_field(page, name, selector, getattr(details, name), scope=scope)
        if (node is not None) != (name in filled):
            raise Stop("billing_fields_changed", field=name)
        if node is None:
            continue
        values = [await node.input_value()]
        if await node.evaluate("n=>n.tagName") == "SELECT":
            values += await node.locator("option:checked").all_text_contents()
        if getattr(details, name).strip().casefold() not in [v.strip().casefold() for v in values]:
            raise Stop("billing_form_changed", field=name)
    save = await one_field(page, "input[name='savePayment']", required=False)
    if save and await save.is_checked():
        raise Stop("payment_save_preference_changed")


async def subscribe_button(page):
    button = page.locator("button[type='submit']").filter(
        has_text=re.compile(r"^\s*(?:订阅|訂閱|Subscribe)\s*$", re.I), visible=True)
    if await button.count() != 1 or not await button.is_enabled():
        raise Stop("official_subscribe_button_not_ready")
    return button
