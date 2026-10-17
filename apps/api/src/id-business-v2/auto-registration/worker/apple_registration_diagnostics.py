"""Observe the frozen engine without changing requests, retries or results."""

from functools import wraps
import time
from types import FunctionType, MethodType

STAGES = {"queued", "sentinel", "signup", "password", "verification_code", "verification_validate",
          "create_account", "workspace", "select_workspace", "redirect", "oauth",
          "identity", "account_save", "sync"}
ERROR_KINDS = {"http_rejected", "network_error", "unknown", "account_creation_failed", "user_exists"}
OFFICIAL_CODES = {"account_creation_failed", "user_exists"}
PUBLIC_FIELDS = {"proxySource", "proxyId", "mailboxSelection", "firstFailure"}


class ObservedClient:
    """Forward the original client; observe sessions only when it returns them."""
    def __init__(self, client, diagnostics, engine):
        object.__setattr__(self, "_client", client)
        object.__setattr__(self, "_diagnostics", diagnostics)
        object.__setattr__(self, "_engine", engine)

    @property
    def session(self):
        session = self._client.session
        self._diagnostics.observe_session(self._engine, session)
        return session

    def __getattr__(self, name):
        return getattr(self._client, name)

    def __setattr__(self, name, value):
        setattr(self._client, name, value)


class ObservedRequests:
    """OAuth's module transport with only this instance's POST observed."""
    def __init__(self, requests, diagnostics):
        self._requests = requests
        self._diagnostics = diagnostics

    def post(self, *args, **kwargs):
        return self._diagnostics.request(self._requests.post, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._requests, name)


def bind_globals(function, **replacements):
    adapted = FunctionType(function.__code__, {**function.__globals__, **replacements},
                           function.__name__, function.__defaults__, function.__closure__)
    adapted.__kwdefaults__ = function.__kwdefaults__
    return wraps(function)(adapted)


class RegistrationDiagnostics:
    def __init__(self, store, task_uuid):
        self.store, self.task_uuid = store, task_uuid
        self.active = None

    def request(self, original, *args, **kwargs):
        """Keep only status and a recognized structured code, never content."""
        observation = self.active
        if observation is None:
            return original(*args, **kwargs)
        observation.update(httpStatus=None, errorKind="unknown")
        try:
            response = original(*args, **kwargs)
        except Exception:
            observation["errorKind"] = "network_error"
            self.store.update_task(self.task_uuid, lastHttpStatus=None)
            raise
        status = getattr(response, "status_code", None)
        status = status if type(status) is int and 100 <= status <= 599 else None
        observation["httpStatus"] = status
        if status is not None and status >= 400:
            observation["errorKind"] = "http_rejected"
            try:
                data = response.json()
                error = data.get("error") if isinstance(data, dict) else None
                code = error.get("code") if isinstance(error, dict) else None
                if isinstance(code, str) and code in OFFICIAL_CODES:
                    observation["errorKind"] = code
            except Exception:
                pass
        self.store.update_task(self.task_uuid, lastHttpStatus=status)
        return response

    def observe_session(self, engine, session=None):
        session = session if session is not None else getattr(engine, "session", None)
        if session is None or getattr(session, "_id_apple_diagnostics", False):
            return
        guard = getattr(engine, "_apple_guard_session", None)
        if callable(guard):
            guard(session)
        for name in ("get", "post"):
            # The password guard calls request() only after its durable check.
            if ((name == "post" and getattr(session, "_id_apple_post", False))
                    or (name == "get" and getattr(session, "_id_apple_get", False))):
                continue
            original = getattr(session, name, None)
            if callable(original):
                setattr(session, name, self.transport(original))
        session._id_apple_diagnostics = True

    def transport(self, original):
        @wraps(original)
        def request(*args, **kwargs):
            return self.request(original, *args, **kwargs)
        return request

    def observe_oauth(self, engine):
        manager = getattr(engine, "oauth_manager", None)
        callback = getattr(manager, "handle_callback", None)
        function = getattr(callback, "__func__", None)
        if not isinstance(function, FunctionType):
            return
        submit = function.__globals__.get("submit_callback_url")
        post = submit.__globals__.get("_post_form") if isinstance(submit, FunctionType) else None
        requests = post.__globals__.get("cffi_requests") if isinstance(post, FunctionType) else None
        if requests is None or not callable(getattr(requests, "post", None)):
            return
        # Clone globals for these three original functions only. Their code,
        # arguments, proxy and parsing remain unchanged; other engines and
        # providers retain the original module functions and transport.
        observed_post = bind_globals(post, cffi_requests=ObservedRequests(requests, self))
        observed_submit = bind_globals(submit, _post_form=observed_post)
        manager.handle_callback = MethodType(bind_globals(function, submit_callback_url=observed_submit), manager)

    def failure(self, observation):
        try:
            self.store.record_failure(self.task_uuid, observation["stage"], observation["errorKind"],
                                      observation["httpStatus"], max(0, int((time.monotonic() - observation["started"]) * 1000)))
        except Exception:
            # Diagnostic storage cannot turn an already-failed original method
            # into success or replace the original exception/return contract.
            # Core password/create/save checkpoints remain fail-closed.
            pass

    def step(self, engine, original, stage, failed, owns_stage=False):
        @wraps(original)
        def call(*args, **kwargs):
            # These integration methods already write their own stage and lease
            # guard. In particular password's checkpoint must stay inside the
            # original method's existing failure handling.
            if not owns_stage:
                if not self.store.update_task(self.task_uuid, stage=stage, lastHttpStatus=None):
                    raise ValueError("任务占用已变化，不能继续执行")
            previous = self.active
            observation = {"stage": stage, "httpStatus": None, "errorKind": "unknown", "started": time.monotonic()}
            self.active = observation
            try:
                self.observe_session(engine)
                result = original(*args, **kwargs)
                self.observe_session(engine)
                if failed(result):
                    self.failure(observation)
                return result
            except Exception:
                self.failure(observation)
                raise
            finally:
                self.active = previous
        return call

    def install(self, engine):
        specifications = {
            "_check_ip_location": ("queued", lambda result: not result[0]),
            "_create_email": ("queued", lambda result: not result),
            "_init_session": ("queued", lambda result: not result),
            "_start_oauth": ("queued", lambda result: not result),
            "_get_device_id": ("queued", lambda result: not result),
            "_check_sentinel": ("sentinel", lambda result: not result),
            "_submit_signup_form": ("signup", lambda result: not getattr(result, "success", True)),
            "_register_password": ("password", lambda result: not result[0]),
            "_send_verification_code": ("verification_code", lambda result: not result),
            "_get_verification_code": ("verification_code", lambda result: not result),
            "_validate_verification_code": ("verification_validate", lambda result: not result),
            "_create_user_account": ("create_account", lambda result: not result),
            "_get_workspace_id": ("workspace", lambda result: not result),
            "_select_workspace": ("select_workspace", lambda result: not result),
            "_follow_redirects": ("redirect", lambda result: not result),
            "_handle_oauth_callback": ("oauth", lambda result: not result),
            "save_to_database": ("account_save", lambda result: not result),
        }
        for name, (stage, failed) in specifications.items():
            original = getattr(engine, name, None)
            if callable(original):
                owns_stage = name in {"_submit_signup_form", "_register_password", "_send_verification_code",
                                      "_create_user_account", "_handle_oauth_callback"}
                setattr(engine, name, self.step(engine, original, stage, failed, owns_stage))
        client = getattr(engine, "http_client", None)
        original_get = getattr(client, "get", None)
        if callable(original_get):
            client.get = self.transport(original_get)
        original_close = getattr(client, "close", None)
        if callable(original_close):
            @wraps(original_close)
            def close(*args, **kwargs):
                result = original_close(*args, **kwargs)
                # Upstream may replace its session during its own device retry.
                # A response from the discarded session must not identify the
                # outcome of an unobserved request on the new one.
                if self.active is not None:
                    self.active.update(httpStatus=None, errorKind="unknown")
                return result
            client.close = close
        if client is not None:
            engine.http_client = ObservedClient(client, self, engine)
        self.observe_oauth(engine)
