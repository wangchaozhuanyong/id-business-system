"""One cancellable deadline for the initial official page and identity reads."""
import asyncio
import re
import time

from checkout_core import Stop


class SessionBudget:
    def __init__(self, seconds, *, cancelled=lambda: False, report=lambda **details: None,
                 clock=time.monotonic, phase=None, parent=None):
        self.seconds = seconds
        self.cancelled = cancelled
        self.report = report
        self.clock = clock
        self.started = clock()
        self.paused = 0
        self.step = "page_load"
        self.phase = phase if phase in {"initial_login", "subscription_check", "checkout_check"} else None
        self.refresh_count = 0
        self.last_report = float("-inf")
        self.parent = parent
        self.human_pause_started = None
        self.human_pause_depth = 0

    @property
    def elapsed(self):
        now = self.clock()
        active_pause = max(0, now - self.human_pause_started) if self.human_pause_started is not None else 0
        return max(0, now - self.started - self.paused - active_pause)

    def check_cancelled(self):
        if self.cancelled():
            raise Stop("operation_cancelled")

    def snapshot(self):
        return {"session_step": self.step, "session_elapsed_seconds": int(self.elapsed),
                "session_wait_seconds": self.seconds, "session_refresh_count": self.refresh_count,
                **({"session_phase": self.phase} if self.phase else {})}

    def remaining_ms(self):
        self.check_cancelled()
        remaining = self.seconds - self.elapsed
        if remaining <= 0:
            raise Stop("session_load_timeout", error_type="TimeoutError")
        remaining_ms = max(1, int(remaining * 1000))
        return min(remaining_ms, self.parent.remaining_ms()) if self.parent else remaining_ms

    async def run(self, operation, step):
        self.step = step
        self.remaining_ms()
        task = asyncio.ensure_future(operation())
        try:
            while True:
                self.check_cancelled()
                remaining = self.remaining_ms() / 1000
                if self.clock() - self.last_report >= 10:
                    self.report(**self.snapshot())
                    self.last_report = self.clock()
                await asyncio.wait({task}, timeout=min(1, remaining))
                self.check_cancelled()
                if task.done():
                    self.remaining_ms()
                    value = await task
                    self.report(**self.snapshot())
                    return value
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def human_wait(self, operation):
        budgets = []
        current = self
        while current:
            if current.human_pause_depth == 0:
                current.human_pause_started = current.clock()
            current.human_pause_depth += 1
            budgets.append(current)
            current = current.parent
        try:
            return await operation()
        finally:
            for current in reversed(budgets):
                current.human_pause_depth -= 1
                if current.human_pause_depth == 0:
                    current.paused += max(0, current.clock() - current.human_pause_started)
                    current.human_pause_started = None

    def restart(self, *, report=None, phase=None):
        """同一窗口的新阶段使用独立预算，并沿用取消信号。"""
        return SessionBudget(self.seconds, cancelled=self.cancelled, report=report or self.report,
                             clock=self.clock, phase=phase or self.phase, parent=self.parent)


RETRYABLE_NETWORK_CODES = {
    "net::ERR_TIMED_OUT", "net::ERR_CONNECTION_TIMED_OUT", "net::ERR_CONNECTION_RESET",
    "net::ERR_CONNECTION_CLOSED", "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_TUNNEL_CONNECTION_FAILED", "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_NETWORK_CHANGED", "net::ERR_EMPTY_RESPONSE", "net::ERR_CONNECTION_REFUSED",
    "net::ERR_INTERNET_DISCONNECTED",
    "NS_ERROR_NET_RESET", "NS_ERROR_NET_TIMEOUT", "NS_ERROR_NET_INTERRUPT",
    "NS_ERROR_CONNECTION_REFUSED", "NS_ERROR_PROXY_CONNECTION_REFUSED",
    "NS_ERROR_UNKNOWN_HOST", "NS_ERROR_UNKNOWN_PROXY_HOST",
}

NETWORK_CODE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])(?:" + "|".join(re.escape(code) for code in sorted(RETRYABLE_NETWORK_CODES))
    + r")(?![A-Za-z0-9_])"
)


def session_failure(error):
    """仅返回异常类别和固定网络码，不回传异常正文或 URL。"""
    name = type(error).__name__
    details = {"error_type": name if name in {
        "TimeoutError", "AssertionError", "Error", "TargetClosedError"
    } else "UnexpectedError"}
    code = NETWORK_CODE_PATTERN.search(str(error))
    if code:
        details["browser_error_code"] = code.group(0)
    reason = ("session_load_timeout" if name == "TimeoutError" else
              "session_network_error" if code else "browser_operation_failed")
    return {"status": "blocked", "reason": reason, **details}


def retryable_page_load_error(error):
    """仅恢复明确传输失败；HTTP 错误、验证和取消不能被网络码覆盖。"""
    report = error.report if isinstance(error, Stop) else session_failure(error)
    return (not report.get("user_action_required") and report.get("http_status") is None
            and report.get("reason") in {"session_load_timeout", "session_network_error"})


async def load_session_page(page, url, budget):
    """同一登录窗口最多两次只读导航；页面响应与账号核实使用同一预算。"""
    for attempt in range(2):
        step = "page_refresh" if attempt else "page_load"
        budget.step = step
        budget.refresh_count = attempt
        budget.report(**budget.snapshot())
        try:
            response = await budget.run(lambda: page.goto(
                url, wait_until="commit", timeout=0), step)
            status = getattr(response, "status", None)
            if type(status) is int and status >= 400:
                raise Stop("verification_required" if status == 403 else "http_error",
                           http_status=status, user_action_required=status == 403)
            return
        except Stop:
            raise
        except Exception as error:
            result = session_failure(error)
            if attempt or result["reason"] not in {"session_load_timeout", "session_network_error"}:
                raise Stop(result.pop("reason"), **result) from None
            # 只有首页 GET 的明确超时/传输失败才再尝试；从不重放登录提交或付款。
            budget.remaining_ms()
    raise Stop("session_load_timeout", error_type="TimeoutError")


def retryable_session_result(result):
    """只重试付款前的页面加载失败，永不重放建单或付款写入。"""
    if (result.get("payment_attempted") is True
            or result.get("payment_requests_sent", 0) != 0
            or result.get("confirmation_requests_sent", 0) != 0
            or result.get("user_action_required") is True):
        return False
    stage = result.get("stage")
    if stage == "session_restore":
        if (result.get("account_matched") is not False
                or result.get("checkout_requests_sent", 0) not in (None, 0)):
            return False
        return result.get("reason") in {"session_load_timeout", "session_network_error"} or (
            result.get("reason") == "browser_operation_failed" and (
                result.get("error_type") == "TimeoutError"
                or result.get("browser_error_code") in RETRYABLE_NETWORK_CODES))
    if (stage not in {"quote_read", "payment_preparation"}
            or result.get("account_matched") is not True
            or result.get("checkout_requests_sent", 0) not in (None, 0, 1)
            or not isinstance(result.get("checkout_identifier"), str)):
        return False
    return result.get("reason") in {
        "actual_quote_unknown", "payment_quote_not_ready", "checkout_page_load_timeout",
        "official_checkout_navigation_not_observed", "checkout_page_network_error",
    } or (
        result.get("reason") == "browser_operation_failed" and (
            result.get("error_type") == "TimeoutError"
            or result.get("browser_error_code") in RETRYABLE_NETWORK_CODES))
