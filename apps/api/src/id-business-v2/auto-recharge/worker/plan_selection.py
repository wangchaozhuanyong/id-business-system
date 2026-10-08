"""官网套餐菜单：只选择控件，调用方独立授权唯一一次建单。"""
import asyncio
import re
import time
from urllib.parse import urlsplit

from playwright.async_api import expect
from checkout_core import Stop
from plans import PRO_GROUP, PRO_PRICE_PLANS, PRO_USAGE_LABELS, selection_spec

STEP_SECONDS = 30
SELECTION_SECONDS = 90
HOME_ENTRY_SECONDS = 2
REGION_TRANSITION_SECONDS = 2
PRICING_URL = "https://chatgpt.com/pricing"
UPGRADE = re.compile(r"^\s*(?:Upgrade|Upgrade plan|升级|升级套餐)\s*$", re.I)
PERSONAL = re.compile(r"^(?:Toggle for switching to Personal plans|切换以改为个人套餐|改为个人套餐|Personal|个人)$", re.I)
PLUS = re.compile(r"^\s*(?:Get Plus|Upgrade to Plus|Get ChatGPT Plus|获取\s*Plus|升级至\s*Plus|升级到\s*Plus|订阅\s*Plus|获得\s*Plus)\s*$", re.I)
GO = re.compile(r"^\s*(?:Get Go|Try Go|Upgrade to Go|Get ChatGPT Go|获取\s*Go|试用\s*Go|升级至\s*Go|升级到\s*Go|订阅\s*Go|获得\s*Go)\s*$", re.I)
PRO = re.compile(r"^\s*(?:Upgrade to Pro|Get Pro|升级至\s*Pro|升级到\s*Pro|获取\s*Pro(?:\s*版本)?)\s*$", re.I)
PRO_UPGRADE = re.compile(r"^\s*(?:Upgrade to Pro|升级至\s*Pro|升级到\s*Pro)\s*$", re.I)
ALL_PLANS = re.compile(r"^\s*查看所有套餐\s*$")
PRO_DETAILS_CARD = '[data-testid="pro-pricing-modal-column-top-half"]'
PLAN_HEADINGS = re.compile(r"^\s*(?:Free|Go|Plus|Pro)\s*$", re.I)
PLUS_HEADING = re.compile(r"^\s*(?:ChatGPT\s*)?Plus\s*$", re.I)
GO_HEADING = re.compile(r"^\s*(?:ChatGPT\s*)?Go\s*$", re.I)
PRO_HEADING = re.compile(r"^\s*(?:ChatGPT\s*)?Pro\s*$", re.I)
STEPS = {'open_menu', 'pricing_page', 'personal_plans', 'choose_tier', 'choose_plan', 'verify_plan'}
ERROR_TYPES = {'TimeoutError', 'AssertionError', 'Error', 'TargetClosedError', 'UnexpectedError'}


def safe_diagnostics(value):
    """只允许受控分类、计数和状态；绝不传递异常正文、HTML 或任意控件文案。"""
    if not isinstance(value, dict):
        return {}
    result = {}
    if isinstance(value.get('step'), str) and value['step'] in STEPS:
        result['step'] = value['step']
    if isinstance(value.get('error_type'), str) and value['error_type'] in ERROR_TYPES:
        result['error_type'] = value['error_type']
    if isinstance(value.get('role'), str) and value['role'] in {'button', 'link', 'radio', 'tab', 'region'}:
        result['role'] = value['role']
    if type(value.get('matched_count')) is int and 0 <= value['matched_count'] <= 100:
        result['matched_count'] = value['matched_count']
    for key in ('enabled', 'selected'):
        if type(value.get(key)) is bool:
            result[key] = value[key]
    plans = value.get('available_plans')
    if isinstance(plans, list):
        result['available_plans'] = [p for p in ('go', 'plus', *PRO_PRICE_PLANS.values()) if p in plans]
    return result


def tier_pattern(tier):
    return re.compile(rf"^\s*(?:{tier}\s*[x×]|(?:相比\s*Plus\s*多\s*)?{tier}\s*倍(?:使用额度)?)\s*$", re.I)


def price_pattern(price):
    # 只匹配明确美元档位/Pro 名称；当地金额和使用倍数不能换算成 500 美元档。
    return re.compile(rf"^\s*(?:Pro\s+{price}|(?:\$\s*{price}(?:\.00)?(?:\s*USD)?|"
                      rf"USD\s*{price}(?:\.00)?|{price}\s*(?:USD|美元))"
                      rf"(?:\s*(?:\/\s*(?:mo(?:nth)?|月)|per month|每月))?)\s*$", re.I)


def pro_groups(scope):
    return scope.get_by_role('radiogroup', name=PRO_GROUP).or_(
        scope.get_by_role('group', name=PRO_GROUP)).filter(visible=True)


def pro_cards(scope):
    return scope.locator(PRO_DETAILS_CARD).filter(visible=True)


async def marked_pro_cards(scope):
    if await scope.count() == 1 and await scope.get_attribute('data-testid') == 'pro-pricing-modal-column-top-half':
        return scope
    return pro_cards(scope)


def pro_detail_groups(card):
    return card.get_by_role('radiogroup').filter(visible=True)


def region_ambiguous(count=None, *, error_type=None):
    diagnostics = {'role': 'region'}
    if type(count) is int and count >= 0:
        diagnostics['matched_count'] = min(count, 100)
    if isinstance(error_type, str) and error_type in ERROR_TYPES:
        diagnostics['error_type'] = error_type
    return Stop('official_plan_region_ambiguous', diagnostics=diagnostics)


async def pro_card(scope, *, details=False):
    """新入口/详情只使用官网已观察的 Pro 专属标记，不能扩大到卡片外。"""
    card = await marked_pro_cards(scope)
    count = await card.count()
    if count != 1:
        raise region_ambiguous(count) if count > 1 else Stop('official_plan_option_not_found')
    product = card.get_by_text('Pro', exact=True).filter(visible=True)
    heading_count = await card.get_by_role('heading').filter(visible=True).count()
    if heading_count != 1:
        raise region_ambiguous(heading_count)
    product_count = await product.count()
    if product_count == 0:
        # 保留原 Pro 子节点归属；新标题仅接受同一标记内唯一语义 Pro 标题。
        product = card.get_by_role('heading', name=PRO_HEADING).filter(visible=True)
        product_count = await product.count()
    if product_count != 1:
        raise region_ambiguous(product_count)
    if not await product.evaluate("""node => {
                const heading = node.closest('h1,h2,h3,h4,h5,h6,[role=heading]');
                const card = node.closest('[data-testid="pro-pricing-modal-column-top-half"]');
                return Boolean(heading && card && card.contains(heading));
            }"""):
        raise region_ambiguous(product_count)
    region = card
    if details and not await card.get_by_role('button').filter(visible=True).count():
        # 仅复用已存在档位组的直属父区域与最终按钮，不能作为详情展开入口。
        parent = card.locator('..')
        if (await parent.count() == 1
                and await pro_cards(parent).count() == 1
                and await parent.get_by_role('heading').filter(visible=True).count() == 1
                and await parent.get_by_role('button').filter(visible=True).count() == 1
                and await buttons(parent, PRO).count() == 1
                and await pro_detail_groups(parent).count() == 1):
            region = parent
    if details:
        groups = pro_detail_groups(region)
        count = await groups.count()
        if count != 1:
            raise region_ambiguous(count) if count > 1 else Stop(
                'official_plan_tier_not_found', diagnostics={'role': 'region', 'matched_count': count})
        if not (await groups.get_attribute('aria-label') or '').strip():
            raise Stop('official_plan_tier_not_found', diagnostics={'role': 'region', 'matched_count': count})
    return region


async def pro_button(scope, target_plan, require_upgrade=False):
    if await (await marked_pro_cards(scope)).count():
        card = await pro_card(scope, details=True)
        choice = await pro_control(card, target_plan)
        groups = pro_detail_groups(card)
        if (await choice.count() != 1 or await choice.get_attribute('aria-checked') != 'true'
                or await groups.locator('[role="radio"][aria-checked="true"]').filter(visible=True).count() != 1):
            raise Stop('selected_plan_changed', stage='plan_selection')
        return card.get_by_role('button').filter(visible=True)
    return buttons(scope, PRO_UPGRADE if require_upgrade else PRO)


async def pro_control(scope, target_plan):
    spec = selection_spec(target_plan)
    marked = bool(await (await marked_pro_cards(scope)).count())
    groups = pro_detail_groups(await pro_card(scope, details=True)) if marked else pro_groups(scope)
    count = await groups.count()
    if count > 1:
        raise region_ambiguous(count)
    if count == 1:
        # 本地币种页面以标准/更多/最高额度选档，金额不能用于推断套餐。
        named = groups.get_by_role('radio', name=re.compile(
            rf'(?:^|\s)(?:{"|".join(PRO_USAGE_LABELS.values())})\s*$', re.I)).filter(visible=True)
        if await named.count():
            return groups.get_by_role('radio', name=re.compile(
                rf'(?:^|\s)(?:{PRO_USAGE_LABELS[target_plan]})\s*$', re.I)).filter(visible=True)
        # 官网当前控件的可访问名称是裸数字 100/200/500，必须限制在明确的 Pro 档位组内。
        numeric = groups.get_by_role('radio', name=re.compile(r'^\s*(?:100|200|500)\s*$'))
        if await numeric.filter(visible=True).count():
            return groups.get_by_role('radio', name=re.compile(rf'^\s*{spec["price_usd"]}\s*$')).filter(visible=True)
    # 新卡片的所有选档路径都必须留在已验证组内，包括显式价格/倍数回退。
    options = groups if marked else scope
    prices = options.get_by_role('radio', name=price_pattern(100))
    for price in (200, 500):
        prices = prices.or_(options.get_by_role('radio', name=price_pattern(price)))
    if await prices.filter(visible=True).count() or spec['tier'] is None:
        return options.get_by_role('radio', name=price_pattern(spec['price_usd'])).filter(visible=True)
    return options.get_by_role('radio', name=tier_pattern(spec['tier'])).filter(visible=True)


def buttons(scope, name):
    return scope.get_by_role('button', name=name).filter(visible=True)


def personal_control(scope):
    return (scope.get_by_role('radio', name=PERSONAL)
            .or_(scope.get_by_role('button', name=PERSONAL))
            .or_(scope.get_by_role('tab', name=PERSONAL))).filter(visible=True)


async def plan_scope(page):
    dialogs = page.get_by_role('dialog').filter(visible=True)
    count = await dialogs.count()
    if count > 1:
        # 转换动画可短暂保留旧弹窗；只等待原先的唯一条件，不选择任意一个。
        try:
            await expect(dialogs).to_have_count(
                1, timeout=max(1, min(REGION_TRANSITION_SECONDS, STEP_SECONDS) * 1000))
        except Exception as exc:
            try:
                count = await dialogs.count()
            except Exception:
                count = None
            error_type = type(exc).__name__ if type(exc).__name__ in ERROR_TYPES else 'UnexpectedError'
            raise region_ambiguous(count, error_type=error_type) from None
        count = await dialogs.count()
        if count != 1:
            raise region_ambiguous(count)
    if count == 1:
        return dialogs
    main = page.get_by_role('main').filter(visible=True)
    return main if await main.count() == 1 else page.locator('body')


class Selection:
    def __init__(self, page, report):
        self.page, self.report = page, report
        self.deadline = time.monotonic() + SELECTION_SECONDS
        self.diagnostics = {'step': 'open_menu', 'available_plans': []}

    def timeout(self):
        return max(1, min(STEP_SECONDS, self.deadline - time.monotonic()) * 1000)

    def step(self, name, role='button'):
        self.diagnostics = {'step': name, 'role': role,
                            'available_plans': self.diagnostics.get('available_plans', [])}
        self.report('plan_selection', diagnostics=safe_diagnostics(self.diagnostics))

    async def observe(self, scope):
        plans = []
        if await buttons(scope, GO).count():
            plans.append('go')
        if await buttons(scope, PLUS).count():
            plans.append('plus')
        card = await marked_pro_cards(scope)
        count = await card.count()
        pro_available = (count == 1 and await pro_detail_groups(card).count() == 1
                         if count else bool(await buttons(scope, PRO).count()))
        if pro_available:
            for plan in PRO_PRICE_PLANS.values():
                if await (await pro_control(scope, plan)).count():
                    plans.append(plan)
        self.diagnostics['available_plans'] = plans

    async def wait_for_plan_scope(self):
        """先在整页等待异步弹窗控件出现，再重新确定唯一套餐区域。"""
        cue = (personal_control(self.page).or_(buttons(self.page, GO)).or_(buttons(self.page, PLUS))
               .or_(buttons(self.page, PRO)).or_(pro_cards(self.page)))
        try:
            await cue.first.wait_for(state='visible', timeout=self.timeout())
        except Exception as exc:
            self.diagnostics['error_type'] = type(exc).__name__ if type(exc).__name__ in ERROR_TYPES else 'UnexpectedError'
            self.diagnostics.pop('matched_count', None)
            try:
                self.diagnostics['matched_count'] = min(await cue.count(), 100)
            except Exception:
                # 页面关闭时不能读取数量；保留原异常分类，不把未测量伪写为零。
                pass
            raise Stop('official_plan_menu_timeout') from None
        scope = await plan_scope(self.page)
        scoped_cue = (personal_control(scope).or_(buttons(scope, GO)).or_(buttons(scope, PLUS))
                      .or_(buttons(scope, PRO)).or_(pro_cards(scope)))
        if not await scoped_cue.count():
            self.diagnostics.update(role='region', matched_count=0)
            raise Stop('official_plan_menu_timeout')
        return scope

    async def ready(self, locator, reason):
        try:
            async def check():
                await expect(locator).to_have_count(1, timeout=self.timeout())
                await expect(locator).to_be_visible(timeout=self.timeout())
                await expect(locator).to_be_enabled(timeout=self.timeout())
            await asyncio.wait_for(check(), timeout=min(STEP_SECONDS, max(.001, self.deadline-time.monotonic())))
        except Exception as exc:
            self.diagnostics['error_type'] = type(exc).__name__ if type(exc).__name__ in ERROR_TYPES else 'UnexpectedError'
            count = await locator.count()
            self.diagnostics['matched_count'] = min(count, 100)
            if count == 1:
                self.diagnostics['enabled'] = await locator.is_enabled()
                if not self.diagnostics['enabled']:
                    reason = 'official_plan_option_disabled'
            elif count > 1:
                reason = 'official_plan_option_ambiguous'
            raise Stop(reason) from None
        self.diagnostics.update(matched_count=1, enabled=True)

    async def wait_native_pro_details(self, scope):
        # 原生路由可能先挂载标题再挂载档位；只在唯一 Pro 卡片内等待，不点击入口。
        card = await pro_card(scope)
        try:
            return await pro_card(scope, details=True)
        except Stop as exc:
            if (exc.report['reason'] != 'official_plan_tier_not_found'
                    or await pro_detail_groups(card).count()):
                raise
        try:
            await pro_detail_groups(card).first.wait_for(state='visible', timeout=self.timeout())
        except Exception as exc:
            error_type = type(exc).__name__ if type(exc).__name__ in ERROR_TYPES else 'UnexpectedError'
            scope = await plan_scope(self.page)
            count = await pro_detail_groups(await pro_card(scope)).count()
            if count > 1:
                raise region_ambiguous(count, error_type=error_type) from None
            raise Stop('official_plan_tier_not_found', diagnostics={
                'role': 'region', 'matched_count': count, 'error_type': error_type}) from None
        # 异步挂载期间可能出现第二个弹窗，重新核验唯一作用域后才返回档位组。
        return await pro_card(await plan_scope(self.page), details=True)

    def require_pricing_origin(self):
        location = urlsplit(self.page.url)
        if location.scheme != 'https' or location.netloc != 'chatgpt.com':
            raise Stop('official_plan_browser_error')

    async def open_pricing_card(self, target_plan):
        """通过官网定价卡进入套餐弹窗；该链接本身不得作为建单按钮返回。"""
        self.step('pricing_page', 'link')
        # 页面控件可能先就绪，defer 脚本仍阻塞 DOMContentLoaded；沿用后续语义等待和原预算。
        response = await self.page.goto(PRICING_URL, wait_until='commit', timeout=self.timeout())
        self.require_pricing_origin()
        if response is None or response.status >= 400:
            raise Stop('official_pricing_plan_entry_not_found')
        pro = selection_spec(target_plan)['price_usd'] is not None
        heading = self.page.get_by_role(
            'heading', name=GO_HEADING if target_plan == 'go' else PRO_HEADING if pro else PLUS_HEADING
        ).filter(visible=True)
        if pro:
            # 原生路由可能异步挂载详情；在原预算内等已知标记或既有营销链接。
            cue = pro_cards(self.page).or_(
                self.page.get_by_role('link', name=PRO).filter(visible=True))
            try:
                await cue.first.wait_for(state='visible', timeout=self.timeout())
            except Exception as exc:
                self.diagnostics['error_type'] = type(exc).__name__ if type(exc).__name__ in ERROR_TYPES else 'UnexpectedError'
                raise Stop('official_pricing_plan_entry_not_found') from None
            self.require_pricing_origin()
            scope = await plan_scope(self.page)
            if await pro_cards(scope).count():
                await self.wait_native_pro_details(scope)
                self.require_pricing_origin()
                # 等待期间可能出现另一个真实弹窗；返回前重新核验唯一作用域与所属组。
                scope = await plan_scope(self.page)
                await pro_card(scope, details=True)
                return scope
            if await self.page.get_by_role('dialog').filter(visible=True).count():
                raise Stop('official_plan_tier_not_found')
        try:
            await expect(heading).to_have_count(1, timeout=self.timeout())
        except Exception as exc:
            self.diagnostics['error_type'] = type(exc).__name__ if type(exc).__name__ in ERROR_TYPES else 'UnexpectedError'
            count = await heading.count()
            self.diagnostics['matched_count'] = min(count, 100)
            reason = 'official_plan_option_ambiguous' if count > 1 else 'official_pricing_plan_entry_not_found'
            raise Stop(reason) from None

        card = heading
        action = None
        for _ in range(8):
            card = card.locator('..')
            card_headings = card.get_by_role('heading', name=PLAN_HEADINGS).filter(visible=True)
            candidate = card.get_by_role('link', name=GO if target_plan == 'go' else PRO if pro else PLUS).filter(visible=True)
            if await card_headings.count() == 1 and await candidate.count():
                action = candidate
                break
        if action is None:
            self.diagnostics['matched_count'] = 0
            raise Stop('official_pricing_plan_entry_not_found')
        await self.ready(action, 'official_pricing_plan_entry_not_found')
        self.require_pricing_origin()
        await action.click(timeout=self.timeout())

        # 真实官网定价卡仅负责导航并打开弹窗，最终建单仍由弹窗按钮触发。
        self.step('open_menu')
        scope = await self.wait_for_plan_scope()
        self.require_pricing_origin()
        return scope

    async def open_menu(self, target_plan):
        self.step('open_menu')
        scope = await plan_scope(self.page)
        pro = selection_spec(target_plan)['price_usd'] is not None
        if pro and await pro_cards(scope).count():
            card = await pro_card(scope)
            try:
                await pro_card(scope, details=True)
            except Stop as exc:
                if (exc.report['reason'] != 'official_plan_tier_not_found'
                        or await pro_detail_groups(card).count()):
                    raise
            else:
                return scope
        visible_options = (personal_control(scope).or_(buttons(scope, GO)).or_(buttons(scope, PLUS))
                           .or_(buttons(scope, PRO)).or_(pro_cards(scope)))
        if not await visible_options.count():
            upgrade = buttons(self.page, UPGRADE)
            # 官网首页同时存在顶部和侧栏 Upgrade；两者均只打开菜单。
            try:
                await upgrade.first.wait_for(
                    state='visible', timeout=min(HOME_ENTRY_SECONDS * 1000, self.timeout())
                )
            except Exception:
                return await self.open_pricing_card(target_plan)
            for opening in range(2):
                await upgrade.first.click(timeout=self.timeout())
                try:
                    scope = await self.wait_for_plan_scope()
                    break
                except Exception:
                    if opening or await self.page.get_by_role('dialog').filter(visible=True).count() or not await upgrade.first.is_visible():
                        raise Stop('official_plan_menu_timeout') from None
        scope = await plan_scope(self.page)
        personal = personal_control(scope)
        if await personal.count():
            self.step('personal_plans')
            await self.ready(personal, 'official_personal_option_not_found')
            role = await personal.get_attribute('role')
            if role == 'radio':
                self.diagnostics['role'] = 'radio'
            if await personal.get_attribute('aria-checked') != 'true' and await personal.get_attribute('aria-selected') != 'true':
                await personal.click(timeout=self.timeout())
            if role == 'radio':
                await expect(personal).to_have_attribute('aria-checked', 'true', timeout=self.timeout())
            elif role == 'tab':
                await expect(personal).to_have_attribute('aria-selected', 'true', timeout=self.timeout())
        scope = await plan_scope(self.page)
        if pro and await pro_cards(scope).count():
            card = await pro_card(scope)
            try:
                await pro_card(scope, details=True)
            except Stop as exc:
                if (exc.report['reason'] != 'official_plan_tier_not_found'
                        or await pro_detail_groups(card).count()):
                    raise
                # 首页概览没有档位，仅读取原生定价路由一次；不点击 Pro CTA 或循环。
                return await self.open_pricing_card(target_plan)
        return scope

    async def open_pro_details(self, scope):
        if (not await pro_cards(scope).count()
                and not await buttons(scope, PRO).count()
                and await buttons(scope, ALL_PLANS).count()):
            self.step('choose_tier')
            navigation = buttons(scope, ALL_PLANS)
            await self.ready(navigation, 'official_plan_option_not_found')
            await navigation.click(timeout=self.timeout())
            scope = await plan_scope(self.page)
            cue = pro_cards(scope).or_(buttons(scope, PRO))
            # 只等待菜单出现；卡片和它的旧名称入口可同时匹配，实际控件仍逐一严格核验。
            await self.ready(cue.first, 'official_plan_tier_not_found')
            scope = await plan_scope(self.page)
        if await pro_cards(scope).count():
            # 标题可能先于档位组挂载；在原预算内只等原生详情，不点击 Pro CTA。
            self.step('choose_tier', 'region')
            return await self.wait_native_pro_details(scope)
        return scope

    async def run(self, target_plan, require_upgrade=False):
        scope = await self.open_menu(target_plan)
        pro = selection_spec(target_plan)['price_usd'] is not None
        if pro:
            scope = await self.open_pro_details(scope)
        await self.observe(scope)
        if pro:
            self.step('choose_tier', 'radio')
            choice = await pro_control(scope, target_plan)
            await self.ready(choice, 'official_plan_tier_not_found')
            if await choice.get_attribute('aria-checked') != 'true':
                await choice.click(timeout=self.timeout())
            await expect(choice).to_have_attribute('aria-checked', 'true', timeout=self.timeout())
            self.diagnostics['selected'] = True
        self.step('choose_plan')
        button = (await pro_button(scope, target_plan, require_upgrade) if pro else
                  buttons(scope, GO if target_plan == 'go' else PLUS))
        await self.ready(button, 'official_plan_option_not_found')
        await self.observe(scope)
        self.report('plan_selection', diagnostics=safe_diagnostics(self.diagnostics))
        return button


async def select_plan(page, target_plan, report, *, require_upgrade=False):
    selection_spec(target_plan)
    selection = Selection(page, report)
    try:
        return await asyncio.wait_for(selection.run(target_plan, require_upgrade), SELECTION_SECONDS)
    except Stop as exc:
        try:
            if re.search(r'Just a moment|Verify.*human|安全验证|请稍候', await page.title(), re.I):
                exc.report['reason'] = 'verification_required'
        except Exception:
            pass
        region = safe_diagnostics(exc.report.get('diagnostics'))
        if region.get('role') == 'region':
            for key in ('role', 'matched_count', 'enabled', 'selected', 'error_type'):
                selection.diagnostics.pop(key, None)
            selection.diagnostics.update({key: region[key] for key in ('role', 'matched_count', 'error_type')
                                          if key in region})
        exc.report.update(stage='plan_selection', diagnostics=safe_diagnostics(selection.diagnostics))
        raise
    except Exception as exc:
        selection.diagnostics['error_type'] = type(exc).__name__ if type(exc).__name__ in ERROR_TYPES else 'UnexpectedError'
        reason = 'official_plan_browser_error'
        if type(exc).__name__ in {'TimeoutError', 'AssertionError'}:
            reason = 'official_upgrade_entry_not_found' if selection.diagnostics['step'] == 'open_menu' else 'official_plan_selection_timeout'
        try:
            if re.search(r'Just a moment|Verify.*human|安全验证|请稍候', await page.title(), re.I):
                reason = 'verification_required'
        except Exception:
            pass
        raise Stop(reason, stage='plan_selection', diagnostics=safe_diagnostics(selection.diagnostics)) from None


async def verify_selected_plan(page, target_plan, *, require_upgrade=False):
    scope = await plan_scope(page)
    pro = selection_spec(target_plan)['price_usd'] is not None
    button = (await pro_button(scope, target_plan, require_upgrade) if pro else
              buttons(scope, GO if target_plan == 'go' else PLUS))
    if await button.count() != 1 or not await button.is_enabled():
        raise Stop('selected_plan_changed', stage='plan_selection')
    if pro:
        choice = await pro_control(scope, target_plan)
        if await choice.count() != 1 or await choice.get_attribute('aria-checked') != 'true':
            raise Stop('selected_plan_changed', stage='plan_selection')
        groups = (pro_detail_groups(await pro_card(scope, details=True))
                  if await (await marked_pro_cards(scope)).count() else pro_groups(scope))
        if await groups.count() == 1 and await groups.locator('[role="radio"][aria-checked="true"]').filter(visible=True).count() != 1:
            raise Stop('selected_plan_changed', stage='plan_selection')
