"""官网套餐菜单：只选择控件，调用方独立授权唯一一次建单。"""
import asyncio
import re
import time

from playwright.async_api import expect
from checkout_core import Stop
from plans import plan_spec

STEP_SECONDS = 30
SELECTION_SECONDS = 90
UPGRADE = re.compile(r"^\s*(?:Upgrade|Upgrade plan|升级|升级套餐)\s*$", re.I)
PERSONAL = re.compile(r"^(?:Toggle for switching to Personal plans|切换以改为个人套餐|改为个人套餐|Personal|个人)$", re.I)
PLUS = re.compile(r"^\s*(?:Get Plus|Upgrade to Plus|Get ChatGPT Plus|获取\s*Plus|升级至\s*Plus|升级到\s*Plus|订阅\s*Plus|获得\s*Plus)\s*$", re.I)
PRO = re.compile(r"^\s*(?:Upgrade to Pro|Get Pro|升级至\s*Pro|升级到\s*Pro|获取\s*Pro)\s*$", re.I)
STEPS = {'open_menu', 'personal_plans', 'choose_tier', 'choose_plan', 'verify_plan'}
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
    if isinstance(value.get('role'), str) and value['role'] in {'button', 'radio', 'tab', 'region'}:
        result['role'] = value['role']
    if type(value.get('matched_count')) is int and 0 <= value['matched_count'] <= 100:
        result['matched_count'] = value['matched_count']
    for key in ('enabled', 'selected'):
        if type(value.get(key)) is bool:
            result[key] = value[key]
    plans = value.get('available_plans')
    if isinstance(plans, list):
        result['available_plans'] = [p for p in ('plus', 'pro-5x', 'pro-20x') if p in plans]
    return result


def tier_pattern(tier):
    return re.compile(rf"^\s*(?:{tier}\s*[x×]|(?:相比\s*Plus\s*多\s*)?{tier}\s*倍(?:使用额度)?)\s*$", re.I)


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
        raise Stop('official_plan_region_ambiguous')
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
        if await buttons(scope, PLUS).count():
            plans.append('plus')
        if await buttons(scope, PRO).count():
            for tier in (5, 20):
                if await scope.get_by_role('radio', name=tier_pattern(tier)).filter(visible=True).count():
                    plans.append(f'pro-{tier}x')
        self.diagnostics['available_plans'] = plans

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

    async def open_menu(self):
        self.step('open_menu')
        scope = await plan_scope(self.page)
        visible_options = personal_control(scope).or_(buttons(scope, PLUS)).or_(buttons(scope, PRO))
        if not await visible_options.count():
            upgrade = buttons(self.page, UPGRADE)
            # 官网首页同时存在顶部和侧栏 Upgrade；两者均只打开菜单。
            await upgrade.first.wait_for(state='visible', timeout=self.timeout())
            for opening in range(2):
                await upgrade.first.click(timeout=self.timeout())
                scope = await plan_scope(self.page)
                cue = personal_control(scope).or_(buttons(scope, PLUS)).or_(buttons(scope, PRO))
                try:
                    await cue.first.wait_for(state='visible', timeout=self.timeout())
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
        return await plan_scope(self.page)

    async def run(self, target_plan):
        scope = await self.open_menu()
        await self.observe(scope)
        tier = plan_spec(target_plan)['tier']
        if tier:
            self.step('choose_tier', 'radio')
            choice = scope.get_by_role('radio', name=tier_pattern(tier)).filter(visible=True)
            await self.ready(choice, 'official_plan_tier_not_found')
            if await choice.get_attribute('aria-checked') != 'true':
                await choice.click(timeout=self.timeout())
            await expect(choice).to_have_attribute('aria-checked', 'true', timeout=self.timeout())
            self.diagnostics['selected'] = True
        self.step('choose_plan')
        button = buttons(scope, PRO if tier else PLUS)
        await self.ready(button, 'official_plan_option_not_found')
        await self.observe(scope)
        self.report('plan_selection', diagnostics=safe_diagnostics(self.diagnostics))
        return button


async def select_plan(page, target_plan, report):
    plan_spec(target_plan)
    selection = Selection(page, report)
    try:
        return await asyncio.wait_for(selection.run(target_plan), SELECTION_SECONDS)
    except Stop as exc:
        try:
            if re.search(r'Just a moment|Verify.*human|安全验证|请稍候', await page.title(), re.I):
                exc.report['reason'] = 'verification_required'
        except Exception:
            pass
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


async def verify_selected_plan(page, target_plan):
    scope = await plan_scope(page)
    tier = plan_spec(target_plan)['tier']
    button = buttons(scope, PRO if tier else PLUS)
    if await button.count() != 1 or not await button.is_enabled():
        raise Stop('selected_plan_changed', stage='plan_selection')
    if tier:
        choice = scope.get_by_role('radio', name=tier_pattern(tier)).filter(visible=True)
        if await choice.count() != 1 or await choice.get_attribute('aria-checked') != 'true':
            raise Stop('selected_plan_changed', stage='plan_selection')
