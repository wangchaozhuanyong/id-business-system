import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { V2_DATA_INTEGRITY_CHECKS } from './lib/v2-data-integrity-audit.mjs';
import {
  parseNativeMysqlTestOptions,
  startNativeMysqlTestInstance
} from './lib/native-mysql-test-instance.mjs';

const containerName = `id-business-v2-financial-integrity-${process.pid}`;
const databaseName = `id_business_v2_financial_integrity_${process.pid}`;
const archiveDatabaseName = `id_business_v2_order_archive_integrity_${process.pid}`;
const runtimeOptions = parseNativeMysqlTestOptions(process.argv.slice(2), ['--order-archive-only']);
const archiveOnly = runtimeOptions.extraFlags.includes('--order-archive-only');
let rootPassword = 'v2_financial_integrity_root_only';
const auditUser = 'id_business_audit';
const auditPassword = 'v2_financial_integrity_audit_only';
const schemaPath = 'apps/api/prisma-mysql/schema.prisma';
let createdContainerId;
let nativeInstance;
const testCounts = [];
const cleanupLabel =
  runtimeOptions.runtime === 'native'
    ? 'remove-owned-disposable-native-mysql'
    : 'remove-owned-disposable-mysql-container';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
    ...(runtimeOptions.runtime === 'native' ? { stdio: 'pipe' } : {})
  });
  if (result.status !== 0) {
    if (runtimeOptions.runtime === 'native')
      throw new Error('财务原生验收子进程失败；SQL、凭据和原始输出已隐藏');
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  recordTestCounts(result);
  return result.stdout?.trim() ?? '';
}

function recordTestCounts(result) {
  if (runtimeOptions.runtime !== 'native' || result.status !== 0) return;
  const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const output = (result.stdout || '').replace(ansi, '');
  for (const match of output.matchAll(/\b(Test Files|Tests)\s+(\d+) passed\s*\((\d+)\)/g))
    testCounts.push({ kind: match[1], passed: Number(match[2]), total: Number(match[3]) });
  for (const match of output.matchAll(/(?:^|\n)[ℹ#] (tests|pass|fail|skipped) (\d+)\b/g))
    testCounts.push({ kind: match[1], count: Number(match[2]) });
}

function runAllowingFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
    ...(runtimeOptions.runtime === 'native' ? { stdio: 'pipe' } : {})
  });
  recordTestCounts(result);
  return result;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mysql(sql, database = databaseName) {
  if (nativeInstance) return nativeInstance.query(sql, database);
  return run('docker', [
    'exec',
    containerName,
    'mysql',
    '--user=root',
    `--password=${rootPassword}`,
    '--batch',
    '--skip-column-names',
    database,
    '--execute',
    sql
  ]);
}

function verifyOrderArchive(rootUrl) {
  // The existing financial suites retain rows. Archive asserts every rule starts
  // clean, so give it a fresh schema in this same caller-owned container.
  mysql(`CREATE DATABASE ${archiveDatabaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const archiveUrl = new URL(rootUrl);
  archiveUrl.pathname = `/${archiveDatabaseName}`;
  run('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: archiveUrl.href }
  });
  const resultFile = resolve('.runtime/financial-integrity', `order-archive-${process.pid}.json`);
  mkdirSync(dirname(resultFile), { recursive: true });
  run(
    'npm',
    [
      'run',
      'test',
      '--workspace=@apple-business/api',
      '--',
      '--run',
      '--no-file-parallelism',
      '--maxWorkers=2',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${resultFile}`,
      'src/id-business-v2/orders/order-archive-mysql.integration.spec.ts'
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: archiveUrl.href,
        V2_FINANCIAL_INTEGRITY_DATABASE_URL: archiveUrl.href
      }
    }
  );
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(result.numTotalTests, 10, '归档真实 MySQL 必须执行完整 10 项');
  assert.equal(result.numPassedTests, 10, '归档真实 MySQL 必须全部通过');
  assert.equal(result.numFailedTests, 0);
  assert.equal(result.numPendingTests, 0, '归档真实 MySQL 不得被跳过');
  assert.equal(result.numTodoTests ?? 0, 0);
  return { database: archiveDatabaseName, executedTests: 10, skippedTests: 0, resultFile };
}

// All counterexamples live inside a disposable database transaction and are rolled back.
// Each starts with a valid row, so a rule cannot pass merely by matching every fixture.
function verifyClosureCounterexamples() {
  const id = (n) => `fc000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const quote = (value) => (value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);
  const row = (table, values) =>
    `INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.values(values).map(quote).join(',')});`;
  const stamp = '2026-10-04 08:00:00.000000';
  const option = (n, type) =>
    row('id_business_v2_options', {
      id: id(n),
      type,
      code: `closure-${n}`,
      name: '合成巡检选项',
      unique_key: `closure-${n}`,
      updated_at: stamp
    });
  const journal = (n, type, sourceType, sourceId, metadata = null, extra = {}) =>
    row('id_business_v2_finance_journals', {
      id: id(n),
      journal_no: `CLOSURE-${n}`,
      journal_type: type,
      source_type: sourceType,
      source_id: sourceId,
      business_date: '2026-10-04',
      period_month: '2026-10',
      occurred_at: stamp,
      summary: '合成巡检凭证',
      idempotency_key: `closure:${n}`,
      updated_at: stamp,
      metadata: metadata === null ? null : JSON.stringify(metadata),
      ...extra
    });
  const line = (n, journalId, code, direction, amount, extra = {}) =>
    row('id_business_v2_finance_journal_lines', {
      id: id(n),
      journal_id: journalId,
      line_no: n,
      account_code: code,
      direction,
      currency: 'CNY',
      amount_original: amount,
      fx_rate_to_cny: 1,
      amount_cny: amount,
      ...extra
    });
  const wallet =
    option(1, 'topup_supplier') +
    row('id_business_v2_topup_supplier_accounts', {
      id: id(2),
      supplier_option_id: id(1),
      opening_balance: 100,
      current_balance: 100,
      opening_balance_cny: 100,
      current_balance_cny: 100,
      initialized_at: stamp,
      updated_at: stamp
    });
  const cash = row('id_business_v2_finance_accounts', {
    id: id(3),
    name: '合成巡检资金',
    account_type: 'bank',
    currency: 'CNY',
    updated_at: stamp
  });
  const customer = row('id_business_v2_customers', {
    id: id(4),
    name: '合成巡检客户',
    phone_search_tokens: '[]',
    wechat_search_tokens: '[]',
    qq_search_tokens: '[]',
    whatsapp_search_tokens: '[]',
    updated_at: stamp
  });
  const account = row('id_business_v2_chatgpt_accounts', {
    id: id(5),
    email_encrypted: 'synthetic-encrypted',
    email_hash: 'closure-audit-only',
    email_masked: '合成账号',
    updated_at: stamp
  });
  const bankOrder = row('id_business_v2_bank_recharge_orders', {
    id: id(6),
    order_no: 'CLOSURE-BANK',
    source: 'manual',
    plan: 'plus',
    charge_amount: 20,
    charge_currency_code: 'USD',
    account_id: id(5),
    customer_id: id(4),
    opened_at: stamp,
    due_at: '2026-11-04 08:00:00',
    updated_at: stamp
  });
  const bankBase = customer + account + bankOrder;
  const bankCompletion = (n, shopping = 3, status = 'posted') =>
    journal(n, 'bank_recharge_completed', 'bank_recharge', id(6), null, { status }) +
    line(n + 1, id(n), 'bank_recharge_revenue', 'credit', 100, { line_no: 1 }) +
    line(n + 2, id(n), 'cash', 'debit', 100, { line_no: 2, finance_account_id: id(3) }) +
    line(n + 3, id(n), 'bank_recharge_usdt_fee', 'debit', 2, { line_no: 3 }) +
    line(n + 4, id(n), 'cash', 'credit', 2, { line_no: 4, finance_account_id: id(3) }) +
    line(n + 5, id(n), 'bank_recharge_shopping_fee', 'debit', shopping, { line_no: 5 }) +
    line(n + 6, id(n), 'cash', 'credit', shopping, { line_no: 6, finance_account_id: id(3) });
  const bankReversal = (n, revenue = 100) =>
    journal(n, 'reversal', 'bank_recharge', id(6), null, { reversal_of_journal_id: id(40) }) +
    line(n + 1, id(n), 'bank_recharge_revenue', 'debit', revenue, { line_no: 1 }) +
    line(n + 2, id(n), 'cash', 'credit', revenue, { line_no: 2, finance_account_id: id(3) }) +
    line(n + 3, id(n), 'bank_recharge_usdt_fee', 'credit', 2, { line_no: 3 }) +
    line(n + 4, id(n), 'cash', 'debit', 2, { line_no: 4, finance_account_id: id(3) }) +
    line(n + 5, id(n), 'bank_recharge_shopping_fee', 'credit', 3, { line_no: 5 }) +
    line(n + 6, id(n), 'cash', 'debit', 3, { line_no: 6, finance_account_id: id(3) });
  const bankState = (profit, usdtFee = 2, shopping = 3, cashBalance = profit) =>
    `UPDATE id_business_v2_bank_recharge_orders SET status='completed',finance_status='posted',accounting_version='subscription_cost_v2',usdt_fee_amount_cny=${usdtFee},shopping_fee_amount_cny=${shopping},profit_amount_cny=${profit} WHERE id='${id(6)}';` +
    `UPDATE id_business_v2_finance_accounts SET current_balance=${cashBalance},current_balance_cny=${cashBalance} WHERE id='${id(3)}';`;
  const correctedBank =
    bankBase +
    cash +
    bankCompletion(40, 3, 'reversed') +
    bankReversal(50) +
    bankCompletion(60, 4) +
    bankState(94, 2, 4);
  const job = row('id_business_v2_recharge_jobs', {
    id: id(7),
    owner_id: 'synthetic-owner',
    account_key: 'synthetic-account',
    plan: 'plus',
    action: 'recharge',
    state: 'finished',
    result: JSON.stringify({ checkout_identifier: 'cs_closure', payment_status: 'paid' }),
    lease_until: stamp,
    updated_at: stamp
  });
  const appleOrder =
    customer +
    option(8, 'service') +
    row('id_business_v2_orders', {
      id: id(9),
      order_no: 'CLOSURE-APPLE',
      customer_id: id(4),
      service_option_id: id(8),
      received_amount: 100,
      received_original_amount: 100,
      website_account_search_tokens: '[]',
      platform_fee_amount: 20,
      profit_amount: 80,
      status: 'completed',
      idempotency_key: 'closure:order',
      updated_at: stamp
    }) +
    journal(10, 'order_completed', 'order', id(9)) +
    line(11, id(10), 'sales_revenue', 'credit', 100) +
    line(12, id(10), 'platform_fee', 'debit', 20);
  const funding = {
    refundFundingVersion: 2,
    fundingSource: 'supplier_wallet',
    sourceLedgerId: id(16),
    supplierAccountId: id(2),
    refundCurrency: 'CNY',
    refundOriginalAmount: '700',
    refundCostAmountCny: '700'
  };
  const cardBase =
    wallet +
    option(13, 'country') +
    option(14, 'gift_card_name') +
    row('id_business_v2_accounts', {
      id: id(15),
      apple_id_encrypted: 'synthetic-encrypted',
      apple_id_hash: 'closure-id-only',
      apple_id_masked: '合成ID',
      apple_id_search_tokens: '[]',
      phone_search_tokens: '[]',
      country_option_id: id(13),
      status_option_id: id(13),
      updated_at: stamp
    }) +
    row('id_business_v2_gift_cards', {
      id: id(17),
      account_id: id(15),
      card_name_option_id: id(14),
      country_option_id: id(13),
      card_name_snapshot: '合成卡',
      country_name_snapshot: '合成地区',
      code_encrypted: 'synthetic-encrypted',
      code_hash: 'closure-card-only',
      code_masked: '合成卡',
      code_tail: '0000',
      code_search_tokens: '[]',
      face_value: 100,
      exchange_rate: 7,
      cost_amount: 700,
      status: 'withdrawn',
      purchase_supplier_account_id: id(2),
      supplier_refund_status: 'pending',
      supplier_refund_amount: 700,
      supplier_refund_amount_cny: 700,
      updated_at: stamp
    }) +
    row('id_business_v2_topup_supplier_ledger', {
      id: id(16),
      supplier_account_id: id(2),
      gift_card_id: id(17),
      entry_type: 'gift_card_debit',
      direction: 'debit',
      amount: 700,
      amount_cny: 700,
      balance_before: 1000,
      balance_after: 300,
      balance_before_cny: 1000,
      balance_after_cny: 300,
      supplier_name_snapshot: '合成供应商',
      idempotency_key: 'closure:debit'
    }) +
    journal(18, 'gift_card_withdrawal_pending', 'gift_card', id(17), funding, {
      idempotency_key: `auto:gift_card_withdrawn:${id(17)}`
    }) +
    line(19, id(18), 'supplier_refund_receivable', 'debit', 700) +
    line(20, id(18), 'gift_card_inventory', 'credit', 700);
  const exchangeBase =
    cash +
    row('id_business_v2_finance_accounts', {
      id: id(21),
      name: '合成目标资金',
      account_type: 'bank',
      currency: 'USD',
      updated_at: stamp
    }) +
    journal(22, 'fx_exchange', 'fx_exchange', id(23)) +
    line(24, id(22), 'cash', 'credit', 100, { finance_account_id: id(3) }) +
    line(25, id(22), 'cash', 'credit', 2, { finance_account_id: id(3) }) +
    line(26, id(22), 'cash', 'debit', 100, {
      finance_account_id: id(21),
      currency: 'USD',
      amount_original: 10,
      fx_rate_to_cny: 10
    }) +
    line(27, id(22), 'fx_exchange_fee', 'debit', 2) +
    row('id_business_v2_finance_exchanges', {
      id: id(23),
      journal_id: id(22),
      source_account_id: id(3),
      target_account_id: id(21),
      source_account_name: '合成资金',
      target_account_name: '合成目标',
      source_currency: 'CNY',
      target_currency: 'USD',
      source_amount: 100,
      target_amount: 10,
      fee_mode: 'source_extra',
      fee_amount: 2,
      total_debit: 102,
      gross_target_amount: 10,
      fee_percent: '.02',
      exchange_rate: '.1',
      effective_rate: '.09803922',
      source_fx_rate_to_cny: 1,
      target_fx_rate_to_cny: 10,
      fee_amount_cny: 2,
      fx_gain_loss_cny: 0,
      occurred_at: stamp,
      idempotency_key: 'closure:exchange',
      request_fingerprint: '0'.repeat(64)
    });
  const cashEvidence = {
    cashHistoricalCost: {
      version: 1,
      inputFingerprint: 'a'.repeat(64),
      accounts: [
        {
          financeAccountId: id(3),
          currency: 'USD',
          balanceBefore: '100',
          balanceBeforeCny: '700',
          incomingOriginal: '0',
          incomingCny: '0',
          creditOriginal: '10',
          transactionCreditCny: '80',
          carryingCreditCny: '70',
          realizedFxCny: '10',
          lineAllocations: [
            {
              lineNo: 60,
              transactionAmountCny: '80',
              transactionFxRateToCny: '8',
              transactionFxRateSnapshotId: null,
              bookCostCny: '70'
            }
          ]
        }
      ]
    }
  };
  const historicalCash =
    cash.replace("'CNY'", "'USD'") +
    journal(59, 'expense', 'expense', id(58), cashEvidence) +
    line(60, id(59), 'cash', 'credit', 70, {
      finance_account_id: id(3),
      currency: 'USD',
      amount_original: 10,
      fx_rate_to_cny: 7
    }) +
    line(61, id(59), 'operating_expense', 'debit', 80) +
    line(62, id(59), 'realized_fx_gain_loss', 'credit', 10, { finance_account_id: id(3) });
  const cases = [
    [
      'cash_historical_cost_evidence_mismatch',
      `${id(59)}:${id(3)}`,
      historicalCash,
      (valid) => valid.replace('"version":1', '"version":0')
    ],
    [
      'cash_historical_cost_evidence_mismatch',
      `${id(59)}:${id(3)}`,
      historicalCash,
      (valid) => valid.replace('"bookCostCny":"70"', '"bookCostCny":"71"')
    ],
    [
      'cash_historical_cost_evidence_mismatch',
      `${id(59)}:${id(3)}`,
      historicalCash,
      (valid) =>
        valid.replace(
          line(62, id(59), 'realized_fx_gain_loss', 'credit', 10, { finance_account_id: id(3) }),
          line(62, id(59), 'realized_fx_gain_loss', 'debit', 10, { finance_account_id: id(3) })
        )
    ],
    [
      'supplier_wallet_gl_mismatch',
      id(2),
      wallet +
        journal(30, 'opening_balance', 'opening_balance', id(2)) +
        line(31, id(30), 'supplier_prepayment', 'debit', 100, { supplier_account_id: id(2) }) +
        journal(32, 'supplier_adjustment', 'supplier_wallet', id(2), null, { status: 'reversed' }) +
        line(33, id(32), 'supplier_prepayment', 'debit', 25, { supplier_account_id: id(2) }) +
        journal(34, 'reversal', 'supplier_wallet', id(2), null, {
          reversal_of_journal_id: id(32)
        }) +
        line(35, id(34), 'supplier_prepayment', 'credit', 25, { supplier_account_id: id(2) }),
      `UPDATE id_business_v2_topup_supplier_accounts SET current_balance_cny=101 WHERE id='${id(2)}';`
    ],
    [
      'gift_card_refund_frozen_source_mismatch',
      id(17),
      cardBase,
      `UPDATE id_business_v2_gift_cards SET supplier_refund_amount_cny=750 WHERE id='${id(17)}';`
    ],
    [
      'gift_card_refund_frozen_source_mismatch',
      id(17),
      cardBase,
      (valid) =>
        valid.replace(
          JSON.stringify(funding),
          JSON.stringify({ ...funding, supplierAccountId: 'wrong-wallet' })
        )
    ],
    [
      'gift_card_refund_frozen_source_mismatch',
      id(17),
      cardBase,
      `UPDATE id_business_v2_gift_cards SET supplier_refund_status='received' WHERE id='${id(17)}';`
    ],
    [
      'finance_cash_source_currency_mismatch',
      id(38),
      journal(37, 'order_completed', 'manual', null) +
        line(38, id(37), 'cash', 'debit', 0, { finance_account_id: null }),
      (valid) =>
        valid.replace(
          line(38, id(37), 'cash', 'debit', 0, { finance_account_id: null }),
          line(38, id(37), 'cash', 'debit', 1, { finance_account_id: null })
        )
    ],
    [
      'finance_cash_source_currency_mismatch',
      id(38),
      journal(37, 'order_completed', 'manual', null) +
        line(38, id(37), 'cash', 'debit', 0, { finance_account_id: null }),
      (valid) =>
        valid.replace(
          line(38, id(37), 'cash', 'debit', 0, { finance_account_id: null }),
          line(38, id(37), 'cash', 'debit', 0, {
            finance_account_id: null,
            amount_cny: 1
          })
        )
    ],
    [
      'finance_cash_source_currency_mismatch',
      id(38),
      cash +
        journal(37, 'supplier_deposit', 'manual', null) +
        line(38, id(37), 'cash', 'credit', 10, { finance_account_id: id(3) }),
      (valid) =>
        valid.replace(
          line(38, id(37), 'cash', 'credit', 10, { finance_account_id: id(3) }),
          line(38, id(37), 'cash', 'credit', 10, { finance_account_id: null })
        )
    ],
    [
      'finance_cash_source_currency_mismatch',
      id(38),
      cash +
        journal(37, 'supplier_deposit', 'manual', null) +
        line(38, id(37), 'cash', 'credit', 10, { finance_account_id: id(3) }),
      (valid) =>
        valid.replace(
          line(38, id(37), 'cash', 'credit', 10, { finance_account_id: id(3) }),
          line(38, id(37), 'cash', 'credit', 10, { finance_account_id: id(3), currency: 'USD' })
        )
    ],
    [
      'order_financial_snapshot_mismatch',
      id(9),
      appleOrder,
      `UPDATE id_business_v2_orders SET platform_fee_amount=21, profit_amount=79 WHERE id='${id(9)}';`
    ],
    [
      'order_financial_snapshot_mismatch',
      id(9),
      appleOrder,
      `UPDATE id_business_v2_orders SET received_fx_rate_to_cny=2 WHERE id='${id(9)}';`
    ],
    [
      'bank_paid_job_order_missing',
      id(7),
      bankBase +
        job +
        `UPDATE id_business_v2_bank_recharge_orders SET recharge_job_id='${id(7)}' WHERE id='${id(6)}';`,
      `UPDATE id_business_v2_bank_recharge_orders SET recharge_job_id=NULL WHERE id='${id(6)}';`
    ],
    [
      'bank_paid_job_order_missing',
      id(7),
      bankBase +
        job.replace('"payment_status":"paid"', '"payment_status":"unknown"') +
        row('id_business_v2_recharge_records', {
          account_key: 'synthetic-account',
          file_key: 'payments/closure.json',
          owner_id: 'synthetic-owner',
          revision: 1,
          document: JSON.stringify({ checkout_identifier: 'cs_closure', payment_status: 'paid' }),
          updated_at: stamp
        }) +
        `UPDATE id_business_v2_bank_recharge_orders SET recharge_job_id='${id(7)}' WHERE id='${id(6)}';`,
      `UPDATE id_business_v2_bank_recharge_orders SET recharge_job_id=NULL WHERE id='${id(6)}';`
    ],
    [
      'bank_order_financial_reconciliation_mismatch',
      id(6),
      bankBase + cash + bankCompletion(40) + bankState(95),
      `UPDATE id_business_v2_bank_recharge_orders SET usdt_fee_amount_cny=3 WHERE id='${id(6)}';`
    ],
    [
      'bank_order_financial_reconciliation_mismatch',
      id(6),
      bankBase +
        cash +
        row('id_business_v2_finance_accounts', {
          id: id(70),
          name: '合成USDT历史成本',
          account_type: 'bank',
          currency: 'USDT',
          opening_balance: 10000,
          opening_balance_cny: 10000,
          current_balance: '9999.5',
          current_balance_cny: '9999.5',
          updated_at: stamp
        }) +
        journal(40, 'bank_recharge_completed', 'bank_recharge', id(6), {
          cashHistoricalCost: {
            version: 1,
            inputFingerprint: 'synthetic-counterexample-only',
            accounts: [
              {
                financeAccountId: id(70),
                currency: 'USDT',
                balanceBefore: '10000',
                balanceBeforeCny: '10000',
                incomingOriginal: '0',
                incomingCny: '0',
                creditOriginal: '0.5',
                transactionCreditCny: '3',
                carryingCreditCny: '0.5',
                realizedFxCny: '2.5',
                lineAllocations: [
                  {
                    lineNo: 4,
                    transactionAmountCny: '3',
                    transactionFxRateToCny: '6',
                    transactionFxRateSnapshotId: null,
                    bookCostCny: '0.5'
                  }
                ]
              }
            ]
          }
        }) +
        line(41, id(40), 'cash', 'debit', 100, { line_no: 1, finance_account_id: id(3) }) +
        line(42, id(40), 'bank_recharge_revenue', 'credit', 100, { line_no: 2 }) +
        line(43, id(40), 'bank_recharge_usdt_fee', 'debit', 3, {
          line_no: 3,
          currency: 'USDT',
          amount_original: '0.5',
          fx_rate_to_cny: 6
        }) +
        line(44, id(40), 'cash', 'credit', '0.5', {
          line_no: 4,
          currency: 'USDT',
          finance_account_id: id(70)
        }) +
        line(45, id(40), 'bank_recharge_shopping_fee', 'debit', 2, { line_no: 5 }) +
        line(46, id(40), 'cash', 'credit', 2, { line_no: 6, finance_account_id: id(3) }) +
        line(47, id(40), 'realized_fx_gain_loss', 'credit', '2.5', {
          line_no: 7,
          finance_account_id: id(70)
        }) +
        bankState('97.5', 3, 2, 98),
      `UPDATE id_business_v2_bank_recharge_orders SET profit_amount_cny=95 WHERE id='${id(6)}';`
    ],
    [
      'bank_order_financial_reconciliation_mismatch',
      id(6),
      correctedBank,
      `UPDATE id_business_v2_bank_recharge_orders SET shopping_fee_amount_cny=3 WHERE id='${id(6)}';`
    ],
    [
      'bank_order_financial_reconciliation_mismatch',
      id(6),
      bankBase + cash + bankCompletion(40) + bankState(95),
      bankCompletion(60) + bankState(190, 4, 6)
    ],
    [
      'finance_reversal_mismatch',
      id(50),
      correctedBank,
      // Both sides remain balanced and bank profit/assets still agree; only the mirror is forged.
      (valid) =>
        valid
          .replace(bankReversal(50), bankReversal(50, 99))
          .replace(bankState(94, 2, 4), bankState(95, 2, 4))
    ],
    [
      'bank_subscription_projection_mismatch',
      id(44),
      bankBase +
        row('id_business_v2_bank_recharge_subscriptions', {
          id: id(44),
          account_id: id(5),
          current_order_id: id(6),
          customer_id: id(4),
          plan: 'plus',
          opened_at: stamp,
          due_at: '2026-11-04 08:00:00',
          updated_at: stamp
        }),
      `UPDATE id_business_v2_bank_recharge_orders SET status='refunded' WHERE id='${id(6)}';`
    ],
    [
      'fx_exchange_principal_fee_mismatch',
      id(23),
      exchangeBase,
      (valid) => valid.replace("'fx_exchange_fee'", "'bank_recharge_usdt_fee'")
    ],
    [
      'bank_soft_delete_safety_mismatch',
      id(6),
      bankBase +
        `UPDATE id_business_v2_bank_recharge_orders SET status='cancelled',deleted_at='${stamp}' WHERE id='${id(6)}';`,
      `UPDATE id_business_v2_bank_recharge_orders SET payment_evidence_id='paid-fact' WHERE id='${id(6)}';`
    ],
    [
      'bank_soft_delete_safety_mismatch',
      id(5),
      account +
        `UPDATE id_business_v2_chatgpt_accounts SET status='disabled',deleted_at='${stamp}' WHERE id='${id(5)}';`,
      `UPDATE id_business_v2_chatgpt_accounts SET official_account_key='official-fact' WHERE id='${id(5)}';`
    ]
  ];
  for (const [code, entityId, valid, mutation] of cases) {
    const rule = V2_DATA_INTEGRITY_CHECKS.find((check) => check.code === code);
    assert.ok(rule, `missing rule ${code}`);
    const query = `SELECT COUNT(*) FROM (${rule.sql}) AS violation WHERE entity_id='${entityId}'`;
    const invalid = typeof mutation === 'function' ? mutation(valid) : valid + mutation;
    const bankCase =
      code === 'bank_order_financial_reconciliation_mismatch' ||
      code === 'finance_reversal_mismatch';
    const balanceProof = bankCase
      ? `SELECT COUNT(*) FROM (
      SELECT journal.id FROM id_business_v2_finance_journals journal
      JOIN id_business_v2_finance_journal_lines line ON line.journal_id=journal.id
      WHERE journal.source_type='bank_recharge' AND journal.source_id='${id(6)}'
      GROUP BY journal.id HAVING SUM(IF(line.direction='debit',line.amount_cny,-line.amount_cny))<>0
    ) unbalanced`
      : null;
    const bankRule =
      code === 'finance_reversal_mismatch'
        ? V2_DATA_INTEGRITY_CHECKS.find(
            (check) => check.code === 'bank_order_financial_reconciliation_mismatch'
          )
        : null;
    const bankAgreement = bankRule
      ? `SELECT COUNT(*) FROM (${bankRule.sql}) violation WHERE entity_id='${id(6)}'`
      : null;
    const proofs = [balanceProof, bankAgreement]
      .filter(Boolean)
      .map((sql) => `${sql};`)
      .join(' ');
    const results = mysql(
      `START TRANSACTION; ${valid} ${query}; ${proofs} ROLLBACK; START TRANSACTION; ${invalid} ${query}; ${proofs} ROLLBACK;`
    )
      .split('\n')
      .map(Number);
    assert.deepEqual(
      results,
      [
        0,
        ...(balanceProof ? [0] : []),
        ...(bankAgreement ? [0] : []),
        1,
        ...(balanceProof ? [0] : []),
        ...(bankAgreement ? [0] : [])
      ],
      `${code}: valid fixture must pass and its counterexample must fail`
    );
  }
  return cases.length;
}

async function main() {
  try {
    let portMatch;
    if (runtimeOptions.runtime === 'native') {
      nativeInstance = await startNativeMysqlTestInstance({
        mysqlBin: runtimeOptions.mysqlBin,
        database: databaseName
      });
      rootPassword = nativeInstance.rootPassword;
      portMatch = [String(nativeInstance.port), String(nativeInstance.port)];
    } else {
      createdContainerId = run('docker', [
        'run',
        '--rm',
        '--detach',
        '--name',
        containerName,
        '--label',
        'codex.task=financial-integrity-acceptance',
        '--memory=512m',
        '--cpus=2',
        '--env',
        `MYSQL_ROOT_PASSWORD=${rootPassword}`,
        '--env',
        `MYSQL_DATABASE=${databaseName}`,
        '--publish',
        '127.0.0.1::3306',
        'mysql:8.4',
        '--character-set-server=utf8mb4',
        '--collation-server=utf8mb4_0900_ai_ci',
        '--default-time-zone=+00:00',
        '--sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
        '--log-bin-trust-function-creators=1'
      ]);
      assert.match(createdContainerId, /^[a-f0-9]{64}$/, '仅清理由当前验收创建的容器');

      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const probe = runAllowingFailure('docker', [
          'exec',
          containerName,
          'mysqladmin',
          'ping',
          '--host=127.0.0.1',
          '--user=root',
          `--password=${rootPassword}`,
          '--silent'
        ]);
        if (probe.status === 0) {
          ready = true;
          break;
        }
        await wait(500);
      }
      if (!ready) throw new Error('财务完整性隔离 MySQL 在 60 秒内未就绪');

      const portOutput = run('docker', ['port', containerName, '3306/tcp']);
      portMatch = portOutput.match(/:(\d+)$/m);
      if (!portMatch) throw new Error('无法解析财务完整性隔离 MySQL 端口');
    }
    const rootUrl = `mysql://root:${rootPassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;
    const auditUrl = `mysql://${auditUser}:${auditPassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;

    run('npm', ['run', 'prisma:mysql:generate'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: rootUrl }
    });
    if (!archiveOnly)
      run('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: rootUrl }
      });

    const archiveProof = verifyOrderArchive(rootUrl);
    if (archiveOnly) {
      console.log(
        JSON.stringify({
          ok: true,
          archiveProof,
          runtime: runtimeOptions.runtime,
          ...(runtimeOptions.runtime === 'native' ? { testCounts } : {}),
          cleanup: cleanupLabel
        })
      );
      return;
    }

    run(
      'npm',
      [
        'run',
        'test',
        '--workspace=@apple-business/api',
        '--',
        '--run',
        // Specs share one database and mutate currency seeds, finance periods and scope versions.
        // Serialize files while preserving every Promise.all concurrency scenario inside each spec.
        '--no-file-parallelism',
        'src/id-business-v2/finance/id-business-v2-financial-integrity-mysql.integration.spec.ts',
        'src/id-business-v2/finance/finance-supplier-closure-mysql.integration.spec.ts',
        'src/id-business-v2/finance/finance-exchange-costs-mysql.integration.spec.ts',
        'src/id-business-v2/orders/order-cash-cost-mysql.integration.spec.ts',
        'src/id-business-v2/auto-recharge/bank-recharge-lifecycle-mysql.integration.spec.ts',
        'src/id-business-v2/auto-recharge/bank-recharge-mysql.integration.spec.ts',
        'src/id-business-v2/data-governance/bank-recharge-governance-mysql.integration.spec.ts',
        'src/id-business-v2/workspace/id-business-v2-website-visit-mysql.integration.spec.ts',
        'src/id-business-v2/auto-recharge/recharge-mysql.integration.spec.ts'
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: rootUrl,
          V2_FINANCIAL_INTEGRITY_DATABASE_URL: rootUrl,
          V2_WEBSITE_VISIT_DATABASE_URL: rootUrl,
          V2_RECHARGE_TEST_DATABASE_URL: rootUrl,
          V2_BANK_RECHARGE_TEST_DATABASE_URL: rootUrl,
          V2_EXCHANGE_COST_TEST_DATABASE_URL: rootUrl
        }
      }
    );

    const provisioned = JSON.parse(
      run('node', ['scripts/provision-v2-data-integrity-auditor.mjs'], {
        env: {
          ...process.env,
          V2_DATA_INTEGRITY_DATABASE_URL: auditUrl,
          MYSQL_DATABASE: databaseName,
          MYSQL_ROOT_PASSWORD: rootPassword,
          MYSQL_HOST_PORT: portMatch[1]
        }
      })
    );
    assert.equal(provisioned.ok, true);
    assert.equal(provisioned.username, auditUser);

    const healthy = JSON.parse(
      run('node', ['scripts/v2-data-integrity-audit.mjs'], {
        env: { ...process.env, V2_DATA_INTEGRITY_DATABASE_URL: auditUrl }
      })
    );
    assert.equal(healthy.ok, true);
    const expectedCodes = V2_DATA_INTEGRITY_CHECKS.map((check) => check.code).sort();
    assert.deepEqual(healthy.checks.map((check) => check.code).sort(), expectedCodes);
    assert.equal(healthy.checkCount, expectedCodes.length);
    assert.equal(healthy.violationCount, 0);
    assert.match(healthy.identity.currentUser, /^id_business_audit@/);
    const counterexampleCount = verifyClosureCounterexamples();

    run('node', ['--test', 'scripts/historical-cash-audit-mysql.test.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, V2_FINANCIAL_INTEGRITY_DATABASE_URL: rootUrl }
    });

    // The CLI runner imports compiled fixtures; CI may have no dist yet.
    // Always build from this source in dependency order instead of reusing dist.
    const buildDatabase = new URL(rootUrl);
    assert.equal(buildDatabase.protocol, 'mysql:');
    assert.equal(buildDatabase.hostname, '127.0.0.1');
    assert.match(buildDatabase.pathname, /^\/id_business_v2_financial_integrity_\d+$/);
    const buildEnv = { ...process.env, DATABASE_URL: rootUrl };
    run('npm', ['run', 'build', '--workspace', '@apple-business/shared'], {
      stdio: 'inherit',
      env: buildEnv
    });
    run('npm', ['run', 'build', '--workspace', '@apple-business/api'], {
      stdio: 'inherit',
      env: buildEnv
    });

    run('node', ['--test', 'scripts/historical-cash-runner-mysql.test.mjs'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        V2_FINANCIAL_INTEGRITY_DATABASE_URL: rootUrl,
        V2_DATA_INTEGRITY_DATABASE_URL: auditUrl
      }
    });

    // Historical negative fixtures keep immutable source rows. Run them after the clean
    // scan and counterexamples; disposal of this container is their only cleanup.
    run(
      'npm',
      [
        'run',
        'test',
        '--workspace=@apple-business/api',
        '--',
        '--run',
        '--no-file-parallelism',
        'src/id-business-v2/finance/historical-cash-mysql.integration.spec.ts'
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: rootUrl,
          V2_FINANCIAL_INTEGRITY_DATABASE_URL: rootUrl,
          V2_WEBSITE_VISIT_DATABASE_URL: rootUrl,
          V2_RECHARGE_TEST_DATABASE_URL: rootUrl,
          V2_BANK_RECHARGE_TEST_DATABASE_URL: rootUrl,
          V2_EXCHANGE_COST_TEST_DATABASE_URL: rootUrl
        }
      }
    );

    const writeAccountAudit = runAllowingFailure('node', ['scripts/v2-data-integrity-audit.mjs'], {
      env: { ...process.env, V2_DATA_INTEGRITY_DATABASE_URL: rootUrl }
    });
    assert.notEqual(writeAccountAudit.status, 0);
    assert.match(
      `${writeAccountAudit.stdout}\n${writeAccountAudit.stderr}`,
      /仅具备 SELECT\/SHOW VIEW 权限/
    );

    const plaintextSql = `INSERT INTO users (id, username, display_name, phone, password_hash, updated_at)
     VALUES ('fa000000-0000-4000-8000-000000000001', 'plaintext-phone', '明文手机号',
             '13800138000', 'integration-only', CURRENT_TIMESTAMP(6));`;
    const plaintextInsert = nativeInstance
      ? nativeInstance.queryResult(plaintextSql, databaseName)
      : runAllowingFailure('docker', [
          'exec',
          containerName,
          'mysql',
          '--user=root',
          `--password=${rootPassword}`,
          databaseName,
          '--execute',
          plaintextSql
        ]);
    assert.notEqual(plaintextInsert.status, 0);
    assert.match(`${plaintextInsert.stdout}\n${plaintextInsert.stderr}`, /Unknown column 'phone'/);

    mysql(
      `INSERT INTO id_business_v2_finance_journals (
       id, journal_no, journal_type, source_type, source_id, business_date,
       period_month, occurred_at, status, summary, idempotency_key, updated_at
     ) VALUES (
       'fa100000-0000-4000-8000-000000000001', 'FINTEGRITY-BROKEN-1', 'expense',
       'expense', 'fa200000-0000-4000-8000-000000000001', '2026-08-28',
       '2026-08', '2026-08-28 10:00:00.000000', 'posted', '故意构造不平凭证',
       'financial-integrity:broken-journal', CURRENT_TIMESTAMP(6)
     );
     INSERT INTO id_business_v2_finance_journal_lines (
       id, journal_id, line_no, account_code, direction, currency,
       amount_original, fx_rate_to_cny, amount_cny
     ) VALUES (
       'fa110000-0000-4000-8000-000000000001',
       'fa100000-0000-4000-8000-000000000001', 1, 'operating_expense', 'debit',
       'CNY', 12.3400, 1.00000000, 12.3400
     );
     INSERT INTO id_business_v2_options (
       id, type, code, name, unique_key, status, updated_at
     ) VALUES (
       'fa300000-0000-4000-8000-000000000001', 'service', 'integrity-service',
       '完整性验收业务', 'service:integrity-service', 'disabled', CURRENT_TIMESTAMP(6)
     );
     INSERT INTO id_business_v2_customers (
       id, name, phone_search_tokens, wechat_search_tokens, qq_search_tokens,
       whatsapp_search_tokens, updated_at
     )
     VALUES (
       'fa310000-0000-4000-8000-000000000001', '完整性验收客户', JSON_ARRAY(),
       JSON_ARRAY(), JSON_ARRAY(), JSON_ARRAY(), CURRENT_TIMESTAMP(6)
     );
     INSERT INTO id_business_v2_orders (
       id, order_no, customer_id, service_option_id, received_amount,
       received_original_amount, website_account_search_tokens, profit_amount, status, opened_at,
       idempotency_key, updated_at
     ) VALUES (
       'fa320000-0000-4000-8000-000000000001', 'FINTEGRITY-ORDER-BROKEN-1',
       'fa310000-0000-4000-8000-000000000001',
       'fa300000-0000-4000-8000-000000000001', 88.8800, 88.8800,
       JSON_ARRAY(), 88.8800, 'completed', '2026-08-28 10:00:00.000000',
       'financial-integrity:broken-order', CURRENT_TIMESTAMP(6)
     );`
    );

    const brokenAudit = runAllowingFailure('node', ['scripts/v2-data-integrity-audit.mjs'], {
      env: { ...process.env, V2_DATA_INTEGRITY_DATABASE_URL: auditUrl }
    });
    assert.equal(brokenAudit.status, 1);
    const broken = JSON.parse(brokenAudit.stdout);
    assert.equal(broken.ok, false);
    assert.ok(broken.failedChecks.includes('finance_journal_unbalanced'));
    assert.ok(broken.failedChecks.includes('completed_order_finance_reconciliation_mismatch'));
    assert.ok(broken.violationCount >= 1);

    console.log(
      JSON.stringify({
        ok: true,
        database: databaseName,
        checkCount: healthy.checkCount,
        counterexampleCount,
        archiveProof,
        verified: [
          'real-mysql-post-rollback-idempotency-concurrency',
          'real-mysql-website-visit-idempotency-reporting-retention',
          'dedicated-readonly-auditor-provisioning',
          'clean-mysql-full-scan',
          'readonly-account-enforcement',
          'plaintext-phone-column-absent',
          'known-unbalanced-journal-detection',
          'known-completed-order-profit-mismatch-detection'
        ],
        runtime: runtimeOptions.runtime,
        ...(runtimeOptions.runtime === 'native' ? { testCounts } : {}),
        cleanup: cleanupLabel
      })
    );
  } finally {
    if (nativeInstance) await nativeInstance.cleanup();
    if (createdContainerId && /^[a-f0-9]{64}$/.test(createdContainerId))
      runAllowingFailure('docker', ['rm', '--force', createdContainerId], { stdio: 'ignore' });
  }
}

await main();
