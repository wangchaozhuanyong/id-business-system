"""充值执行器独立进程回归；浏览器和业务任务仅使用合成替身。"""
import asyncio
import io
import json
import multiprocessing
import os
import unittest
from unittest.mock import AsyncMock

import server


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


def worker_process(pipe):
    """不连接官网/API，不读取环境凭据；执行真实 Handler 与运行时线程。"""
    server.WORKER_ROLE = 'recharge'
    server.TOKEN = 'fixture-worker-authorization'
    server.Handler.job = None
    server.Job = WaitingRecharge
    runtime = server.PersistentBrowserRuntime(browser_factory=fixture_browser)
    server.BROWSER_RUNTIME = runtime
    runtime.start()
    try:
        pipe.send({'pid': os.getpid(), 'ready': runtime.started})
        while True:
            command = pipe.recv()
            if command[0] == 'stop':
                return
            if command[0] == 'crash':
                os._exit(70)
            if command[0] == 'restore-existing':
                server.Handler.job = WaitingRecharge(JOB_ID, {
                    'plan': 'plus', 'action': 'server', 'manualPaymentConfirmation': True})
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
        for name in ('first', 'second'):
            parent, child = context.Pipe()
            process = context.Process(target=worker_process, args=(child,))
            process.start()
            child.close()
            self.workers[name] = (process, parent)
            self.assertTrue(parent.poll(10), f'{name} worker did not start')
            self.assertTrue(parent.recv()['ready'])
        self.assertNotEqual(self.workers['first'][0].pid, self.workers['second'][0].pid)

    def stop_workers(self):
        for process, pipe in self.workers.values():
            if process.is_alive():
                pipe.send(('stop',))
            process.join(5)
            if process.is_alive():
                process.terminate()
                process.join(5)
            pipe.close()

    def request(self, name, method, path, body=None):
        _, pipe = self.workers[name]
        pipe.send(('request', method, path, body or {}))
        self.assertTrue(pipe.poll(5), f'{name} request did not finish')
        return pipe.recv()

    def restore_existing_job(self, name):
        _, pipe = self.workers[name]
        pipe.send(('restore-existing',))
        self.assertTrue(pipe.poll(5))
        self.assertTrue(pipe.recv())
        health = self.request(name, 'GET', '/health')[1]
        self.assertTrue(health['busy'])
        self.assertEqual(health['workerRole'], 'recharge')

    def test_retired_start_and_registration_routes_preserve_existing_waiting_job(self):
        self.restore_existing_job('first')
        self.assertEqual(self.request('first', 'POST', f'/jobs/{OTHER_ID}',
                                     {'plan': 'plus', 'action': 'server'}),
                         (410, {'ok': False, 'reason': 'server_recharge_retired'}))
        for path in ('/registration/health', f'/registration/jobs/{JOB_ID}/status',
                     f'/registration/jobs/{JOB_ID}/cancel', f'/registration/jobs/{JOB_ID}/code'):
            for method in ('GET', 'POST'):
                with self.subTest(method=method, path=path):
                    self.assertEqual(self.request('first', method, path), (404, {'ok': False}))
        receipt = self.request('first', 'GET', f'/jobs/{JOB_ID}/status')[1]
        self.assertFalse(receipt['done'])
        self.assertFalse(receipt['cancelled'])
        self.assertFalse(receipt['confirmation_received'])

    def test_cancel_and_process_exit_do_not_change_another_recharge_worker(self):
        for name in self.workers:
            self.restore_existing_job(name)
        self.assertEqual(self.request('first', 'POST', f'/jobs/{JOB_ID}/cancel')[0], 202)
        process, pipe = self.workers['first']
        pipe.send(('crash',))
        process.join(5)
        self.assertEqual(process.exitcode, 70)
        self.assertTrue(self.request('second', 'GET', '/health')[1]['busy'])
        receipt = self.request('second', 'GET', f'/jobs/{JOB_ID}/status')[1]
        self.assertFalse(receipt['done'])
        self.assertFalse(receipt['cancelled'])
        self.assertFalse(receipt['confirmation_received'])


class RuntimeLifecycleTests(unittest.TestCase):
    def test_lazy_start_reuses_browser_and_shutdown_closes_owned_resource(self):
        factory = AsyncMock(side_effect=fixture_browser)
        runtime = server.PersistentBrowserRuntime(browser_factory=factory)
        runtime.start()
        try:
            self.assertTrue(runtime.started)
            factory.assert_not_awaited()
            first = runtime.run(lambda browser: asyncio.sleep(0, result=browser))
            second = runtime.run(lambda browser: asyncio.sleep(0, result=browser))
            self.assertIs(first, second)
            factory.assert_awaited_once()
            self.assertTrue(first.connected)
        finally:
            runtime.stop()
        self.assertFalse(first.connected)
        self.assertFalse(runtime.started)


if __name__ == '__main__':
    unittest.main()
