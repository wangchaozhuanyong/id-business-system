"""真实独立子进程中的路由/生命周期回归；浏览器和业务任务使用合成替身。"""
import asyncio
import io
import json
import multiprocessing
import os
import threading
import unittest
from unittest.mock import AsyncMock, patch

import server
import registration_builtin


JOB_ID = '11111111-1111-4111-8111-111111111111'
OTHER_ID = '22222222-2222-4222-8222-222222222222'


class FixtureBrowser:
    def __init__(self):
        self.connected = True

    def is_connected(self):
        return self.connected

    async def close(self):
        self.connected = False


async def fixture_browser():
    return FixtureBrowser()


class WaitingRecharge(server.Job):
    def __init__(self, job_id, payload):
        super().__init__(job_id, payload)
        self.waiting_confirmation = True
        self.nonce = 'fixture-confirmation'

    def run(self):
        self.confirm_event.wait(30)
        self.done = True


class WaitingRegistration(registration_builtin.RegistrationServerJob):
    def __init__(self, job_id, body, callback_base, runtime):
        self.id, self.attempt, self.runtime = job_id, body['attempt'], runtime
        self.cancelled = threading.Event()
        self.done = False
        self.code_deliveries = 0
        registration_builtin.PROFILES.profile = {
            'id': 'fixture-profile', 'job_id': job_id,
            'browser': FixtureBrowser(), 'proxy': {}
        }

    def run(self):
        self.cancelled.wait(30)
        self.done = True

    def signal_code(self, code, attempt, step, mail_id=None):
        if attempt != self.attempt or step != 'email_code':
            raise ValueError()
        self.code_deliveries += 1

    def cancel(self):
        self.cancelled.set()
        self.runtime.run_registration(lambda: registration_builtin.PROFILES.close(self.id))
        self.done = True


def worker_process(role, pipe):
    """不连接官网/API，不读取环境凭据；执行真实 Handler 与运行时线程。"""
    server.WORKER_ROLE = role
    server.TOKEN = 'fixture-worker-authorization'
    server.Handler.job = None
    registration_builtin.PROFILES.profile = None
    server.Job = WaitingRecharge
    registration_builtin.RegistrationServerJob = WaitingRegistration
    runtime = server.PersistentBrowserRuntime(
        browser_factory=fixture_browser, registration_owner=role == 'registration')
    server.BROWSER_RUNTIME = runtime
    runtime.start()
    try:
        pipe.send({'pid': os.getpid(), 'ready': runtime.started})
        while True:
            command = pipe.recv()
            if command[0] == 'stop':
                return
            if command[0] == 'crash':
                os._exit(70)  # 与充值 watchdog 相同的进程终止范围。
            if command[0] == 'partial':
                server.Handler.job.done = True
                pipe.send(True)
                continue
            _, method, path, value = command
            handler = object.__new__(server.Handler)
            handler.path = path
            body = json.dumps(value).encode()
            handler.headers = {'X-Recharge-Worker': server.TOKEN,
                               'Content-Length': str(len(body))}
            handler.rfile = io.BytesIO(body)
            replies = []
            handler.reply = lambda status, result: replies.append((status, result))
            (handler.do_GET if method == 'GET' else handler.do_POST)()
            pipe.send(replies[0])
    finally:
        runtime.stop()
        pipe.close()


class WorkerIsolationTests(unittest.TestCase):
    def setUp(self):
        self.workers = {}
        context = multiprocessing.get_context('spawn')
        self.addCleanup(self.stop_workers)
        for role in ('registration', 'recharge'):
            parent, child = context.Pipe()
            process = context.Process(target=worker_process, args=(role, child))
            process.start()
            child.close()
            self.workers[role] = (process, parent)
            self.assertTrue(parent.poll(10), f'{role} worker did not start')
            self.assertTrue(parent.recv()['ready'])
        self.assertNotEqual(self.workers['registration'][0].pid, self.workers['recharge'][0].pid)

    def stop_workers(self):
        for process, pipe in self.workers.values():
            if process.is_alive():
                pipe.send(('stop',))
            process.join(5)
            if process.is_alive():
                process.terminate()
                process.join(5)
            pipe.close()

    def request(self, role, method, path, body=None):
        _, pipe = self.workers[role]
        pipe.send(('request', method, path, body or {}))
        self.assertTrue(pipe.poll(5), f'{role} request did not finish')
        return pipe.recv()

    def start_both(self, first='registration'):
        for role in (first, 'recharge' if first == 'registration' else 'registration'):
            path = f'/registration/jobs/{JOB_ID}' if role == 'registration' else f'/jobs/{JOB_ID}'
            body = {'attempt': 1} if role == 'registration' else {
                'plan': 'plus', 'action': 'server', 'manualPaymentConfirmation': True}
            self.assertEqual(self.request(role, 'POST', path, body)[0], 202)
        for role in self.workers:
            health = self.request(role, 'GET', '/health')[1]
            self.assertTrue(health['busy'])
            self.assertEqual(health['workerRole'], role)

    def test_both_accept_concurrently_and_keep_same_type_exclusion(self):
        self.start_both()
        self.assertEqual(self.request('recharge', 'POST', f'/jobs/{OTHER_ID}',
                                     {'plan': 'plus', 'action': 'server'})[0], 409)
        self.assertEqual(self.request('registration', 'POST', f'/registration/jobs/{OTHER_ID}',
                                     {'attempt': 1}), (409, {'ok': False, 'reason': 'worker_busy'}))
        self.assertEqual(self.request('registration', 'POST', f'/registration/jobs/{JOB_ID}',
                                     {'attempt': 1})[0], 202)
        for role, wrong_paths in (
            ('registration', [f'/jobs/{JOB_ID}/status', f'/jobs/{JOB_ID}/cancel',
                              f'/jobs/{JOB_ID}/confirm', f'/jobs/{JOB_ID}/handoff']),
            ('recharge', ['/registration/health', f'/registration/jobs/{JOB_ID}/status',
                          f'/registration/jobs/{JOB_ID}/cancel', f'/registration/jobs/{JOB_ID}/code'])
        ):
            for path in wrong_paths:
                for method in ('GET', 'POST'):
                    with self.subTest(role=role, method=method, path=path):
                        self.assertEqual(self.request(role, method, path), (404, {'ok': False}))
        self.assertFalse(self.request('recharge', 'GET', f'/jobs/{JOB_ID}/status')[1]['confirmation_received'])
        self.assertTrue(self.request('registration', 'GET', '/registration/health')[1]['registrationBusy'])

    def test_retained_partial_registration_does_not_block_new_recharge(self):
        self.assertEqual(self.request('registration', 'POST', f'/registration/jobs/{JOB_ID}',
                                     {'attempt': 1})[0], 202)
        _, pipe = self.workers['registration']
        pipe.send(('partial',))
        self.assertTrue(pipe.poll(5))
        self.assertTrue(pipe.recv())
        health = self.request('registration', 'GET', '/registration/health')[1]
        self.assertFalse(health['registrationBusy'])
        self.assertTrue(health['registrationWindowRetained'])
        self.assertEqual(self.request('recharge', 'POST', f'/jobs/{JOB_ID}',
                                     {'plan': 'plus', 'action': 'server',
                                      'manualPaymentConfirmation': True})[0], 202)
        self.assertEqual(self.request('registration', 'POST', f'/registration/jobs/{OTHER_ID}',
                                     {'attempt': 1}),
                         (409, {'ok': False, 'reason': 'builtin_original_window_pending'}))

    def test_cancel_and_recharge_process_exit_leave_registration_usable(self):
        self.start_both(first='recharge')
        self.assertEqual(self.request('recharge', 'POST', f'/jobs/{JOB_ID}/cancel')[0], 202)
        receipt = self.request('registration', 'GET', f'/registration/jobs/{JOB_ID}/status')[1]
        self.assertFalse(receipt['done'])
        self.assertFalse(receipt['cancelled'])
        process, pipe = self.workers['recharge']
        pipe.send(('crash',))
        process.join(5)
        self.assertEqual(process.exitcode, 70)
        self.assertTrue(self.request('registration', 'GET', '/registration/health')[1]['registrationBusy'])
        self.assertEqual(self.request('registration', 'POST', f'/registration/jobs/{JOB_ID}/code',
                                     {'attempt': 1, 'step': 'email_code', 'code': '123456'})[0], 202)

    def test_registration_cancel_does_not_authorize_or_cancel_recharge(self):
        self.start_both()
        self.assertEqual(self.request('registration', 'POST', f'/registration/jobs/{JOB_ID}/cancel',
                                     {'attempt': 1})[0], 202)
        health = self.request('registration', 'GET', '/registration/health')[1]
        self.assertFalse(health['registrationWindowRetained'])
        receipt = self.request('recharge', 'GET', f'/jobs/{JOB_ID}/status')[1]
        self.assertFalse(receipt['done'])
        self.assertFalse(receipt['cancelled'])
        self.assertFalse(receipt['confirmation_received'])


class RuntimeOwnershipTests(unittest.TestCase):
    def test_only_registration_runtime_shutdown_closes_registration_profile(self):
        for registration_owner in (False, True):
            with self.subTest(registration_owner=registration_owner):
                runtime = server.PersistentBrowserRuntime(registration_owner=registration_owner)
                runtime._discard = AsyncMock()
                with (patch.object(registration_builtin.PROFILES, 'profile', {'job_id': JOB_ID}),
                      patch.object(registration_builtin.PROFILES, 'close', AsyncMock()) as close):
                    asyncio.run(runtime._shutdown())
                    if registration_owner:
                        close.assert_awaited_once_with(JOB_ID)
                    else:
                        close.assert_not_awaited()


class RuntimePrewarmOwnershipTests(unittest.TestCase):
    def test_only_registration_role_prewarms_and_recharge_run_still_reuses_browser(self):
        for registration_owner in (False, True):
            with self.subTest(registration_owner=registration_owner):
                factory = AsyncMock(side_effect=fixture_browser)
                runtime = server.PersistentBrowserRuntime(browser_factory=factory,
                                                          registration_owner=registration_owner)
                runtime.start()
                try:
                    self.assertTrue(runtime.started)
                    self.assertEqual(factory.await_count, int(registration_owner))
                    first = runtime.run(lambda browser: asyncio.sleep(0, result=browser))
                    second = runtime.run(lambda browser: asyncio.sleep(0, result=browser))
                    self.assertIs(first, second)
                    self.assertEqual(factory.await_count, 1)
                finally:
                    runtime.stop()
