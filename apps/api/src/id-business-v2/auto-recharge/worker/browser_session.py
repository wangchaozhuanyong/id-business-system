"""One cancellable deadline for the initial official page and identity reads."""
import asyncio
import time

from checkout_core import Stop


class SessionBudget:
    def __init__(self, seconds, *, cancelled=lambda: False, report=lambda **details: None,
                 clock=time.monotonic):
        self.seconds = seconds
        self.cancelled = cancelled
        self.report = report
        self.clock = clock
        self.started = clock()
        self.paused = 0
        self.step = "page_load"
        self.last_report = float("-inf")

    @property
    def elapsed(self):
        return max(0, self.clock() - self.started - self.paused)

    def check_cancelled(self):
        if self.cancelled():
            raise Stop("operation_cancelled")

    def remaining_ms(self):
        self.check_cancelled()
        remaining = self.seconds - self.elapsed
        if remaining <= 0:
            raise Stop("session_load_timeout", error_type="TimeoutError")
        return max(1, int(remaining * 1000))

    async def run(self, operation, step):
        self.step = step
        self.remaining_ms()
        task = asyncio.ensure_future(operation())
        try:
            while True:
                self.check_cancelled()
                remaining = self.remaining_ms() / 1000
                if self.clock() - self.last_report >= 10:
                    self.report(session_step=step, session_elapsed_seconds=int(self.elapsed),
                                session_wait_seconds=self.seconds)
                    self.last_report = self.clock()
                await asyncio.wait({task}, timeout=min(1, remaining))
                self.check_cancelled()
                if task.done():
                    self.remaining_ms()
                    value = await task
                    self.report(session_step=step, session_elapsed_seconds=int(self.elapsed),
                                session_wait_seconds=self.seconds)
                    return value
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def human_wait(self, operation):
        started = self.clock()
        try:
            return await operation()
        finally:
            self.paused += self.clock() - started


RETRYABLE_NETWORK_CODES = {
    "net::ERR_TIMED_OUT", "net::ERR_CONNECTION_TIMED_OUT", "net::ERR_CONNECTION_RESET",
    "net::ERR_CONNECTION_CLOSED", "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_TUNNEL_CONNECTION_FAILED", "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_NETWORK_CHANGED", "net::ERR_EMPTY_RESPONSE", "net::ERR_CONNECTION_REFUSED",
    "net::ERR_INTERNET_DISCONNECTED",
}


def retryable_session_result(result):
    if (result.get("stage") != "session_restore" or result.get("account_matched") is not False
            or result.get("checkout_requests_sent") != 0
            or result.get("payment_attempted") is True
            or result.get("payment_requests_sent", 0) != 0
            or result.get("confirmation_requests_sent", 0) != 0
            or result.get("user_action_required") is True):
        return False
    return result.get("reason") in {"session_load_timeout", "session_network_error"} or (
        result.get("reason") == "browser_operation_failed" and (
            result.get("error_type") == "TimeoutError"
            or result.get("browser_error_code") in RETRYABLE_NETWORK_CODES))
