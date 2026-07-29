#!/usr/bin/env python3
"""Read-only verifier for the ID business V2 Excel scope."""

from __future__ import annotations

import argparse
import json
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DEFAULT_WORKBOOK = Path("/Users/wangchao/Downloads/id记录.xlsx")

EXPECTED_SHEETS = [
    "仪表盘",
    "工作台-续费操作",
    "工作台-订单录入",
    "工作台-加卡",
    "ID录入",
    "订单管理",
    "客户记录",
    "加卡记录",
    "开通记录",
    "汇率采集",
    "选项设置",
]

EXPECTED_ROWS = {
    ("工作台-续费操作", 1): [
        "排序",
        "客户",
        "ID账号",
        "客户网站账号",
        "ID余额",
        "开通业务",
        "开通时间",
        "到期时间",
        "状态",
        "操作",
    ],
    ("工作台-加卡", 3): [
        "排序",
        "ID账号",
        "ID国家",
        "ID余额",
        "人民币成本",
        "平均成本",
        "加卡记录",
        "余额变动",
        "最近加卡",
        "更新时间",
        "历史开通业务",
        "当前开通业务",
        "ID状态",
        "操作",
    ],
    ("ID录入", 1): [
        "排序",
        "ID账号",
        "ID密码",
        "手机号码",
        "密保",
        "ID地区",
        "余额",
        "人民币成本",
        "ID购买成本",
        "供应商",
        "ID状态",
        "更新时间",
        "操作",
    ],
    ("订单管理", 1): [
        "排序",
        "订单号",
        "客户名称",
        "业务名称",
        "使用ID",
        "客户网站账号",
        "结算平台",
        "平台订单号",
        "实收金额",
        "平台手续费",
        "ID成本",
        "余额成本",
        "退款成本",
        "利润",
        "消耗余额",
        "开通时间",
        "到期时间",
        "备注",
        "状态",
        "操作",
    ],
    ("客户记录", 1): [
        "排序",
        "客户名称",
        "手机号",
        "微信",
        "来源",
        "标签",
        "常开业务",
        "备注",
        "操作",
    ],
    ("加卡记录", 1): [
        "排序",
        "礼品卡号",
        "面值",
        "卡片汇率",
        "加入ID",
        "供应商",
        "加入前余额",
        "加入后余额",
        "变动时间",
        "状态",
        "操作",
    ],
    ("开通记录", 1): [
        "排序",
        "订单",
        "客户",
        "业务",
        "苹果ID",
        "客户网站账号",
        "开通日期",
        "到期日期",
        "状态",
        "操作",
    ],
    ("选项设置", 1): [
        "ID状态",
        "ID地区",
        "客户来源",
        "客户标签",
        "业务名称",
        "ID供应商",
        "加卡供应商",
        "结算平台",
    ],
}

EXPECTED_TEXT = [
    ("仪表盘", "A1", "暂时不开发"),
    ("工作台-续费操作", "J2", "充值"),
    ("工作台-续费操作", "J2", "开通"),
    ("工作台-续费操作", "J2", "取消"),
    ("工作台-订单录入", "A1", "订单管理"),
    ("工作台-订单录入", "A3", "对应国家"),
    ("工作台-加卡", "A1", "快捷筛选"),
    ("工作台-加卡", "A2", "状态正常"),
    ("工作台-加卡", "L4", "业务到期后代表当前无业务"),
    ("工作台-加卡", "N5", "自动采集礼品卡图片"),
    ("工作台-加卡", "I8", "48小时以上都用天表示"),
    ("ID录入", "M2", "修改"),
    ("ID录入", "M2", "删除"),
    ("ID录入", "M2", "停用"),
    ("ID录入", "M3", "启用"),
    ("订单管理", "T2", "退款"),
    ("订单管理", "T2", "修改"),
    ("订单管理", "T2", "取消"),
    ("订单管理", "T2", "删除"),
    ("订单管理", "U2", "退款成本"),
    ("客户记录", "I2", "修改"),
    ("客户记录", "I2", "取消"),
    ("客户记录", "I2", "删除"),
    ("加卡记录", "K2", "被赎回"),
    ("加卡记录", "K2", "修改"),
    ("加卡记录", "K2", "撤回"),
    ("汇率采集", "A1", "币安"),
    ("汇率采集", "A1", "欧易"),
    ("汇率采集", "A1", "中间价格"),
    ("选项设置", "A5", "正常跟冻结是固定两个选项"),
    ("选项设置", "H5", "固定手续费"),
    ("选项设置", "H5", "手续费百分比"),
]


def column_name(index: int) -> str:
    result = ""
    value = index
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def worksheet_path(target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join("xl", target))


def read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [
        "".join(node.text or "" for node in item.findall(f".//{{{MAIN_NS}}}t"))
        for item in root.findall(f"{{{MAIN_NS}}}si")
    ]


def read_cells(
    archive: zipfile.ZipFile, path: str, shared_strings: list[str]
) -> dict[str, str]:
    root = ET.fromstring(archive.read(path))
    cells: dict[str, str] = {}
    for cell in root.findall(f".//{{{MAIN_NS}}}c"):
        reference = cell.attrib.get("r")
        if not reference:
            continue
        cell_type = cell.attrib.get("t")
        if cell_type == "inlineStr":
            value = "".join(
                node.text or "" for node in cell.findall(f".//{{{MAIN_NS}}}t")
            )
        else:
            value_node = cell.find(f"{{{MAIN_NS}}}v")
            value = value_node.text if value_node is not None and value_node.text else ""
            if cell_type == "s" and value:
                value = shared_strings[int(value)]
        cells[reference] = value.strip()
    return cells


def load_workbook(path: Path) -> tuple[list[str], dict[str, dict[str, str]]]:
    with zipfile.ZipFile(path) as archive:
        workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
        rels_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relationships = {
            relation.attrib["Id"]: relation.attrib["Target"]
            for relation in rels_root.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
        }
        shared_strings = read_shared_strings(archive)
        sheets: list[str] = []
        cells_by_sheet: dict[str, dict[str, str]] = {}
        for sheet in workbook_root.findall(f".//{{{MAIN_NS}}}sheet"):
            name = sheet.attrib["name"]
            relationship_id = sheet.attrib[f"{{{REL_NS}}}id"]
            sheets.append(name)
            cells_by_sheet[name] = read_cells(
                archive,
                worksheet_path(relationships[relationship_id]),
                shared_strings,
            )
    return sheets, cells_by_sheet


def verify(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise AssertionError(f"Excel 基准文件不存在：{path}")
    sheets, cells_by_sheet = load_workbook(path)
    if sheets != EXPECTED_SHEETS:
        raise AssertionError(
            f"工作表范围发生变化：expected={EXPECTED_SHEETS}, actual={sheets}"
        )

    results: list[dict[str, str]] = [
        {"check": "sheet_order", "status": "pass", "detail": f"{len(sheets)} sheets"}
    ]
    for (sheet_name, row_number), expected in EXPECTED_ROWS.items():
        actual = [
            cells_by_sheet[sheet_name].get(f"{column_name(index)}{row_number}", "")
            for index in range(1, len(expected) + 1)
        ]
        if actual != expected:
            raise AssertionError(
                f"{sheet_name}!{row_number} 表头发生变化：expected={expected}, actual={actual}"
            )
        results.append(
            {
                "check": f"{sheet_name}_headers",
                "status": "pass",
                "detail": f"{len(expected)} columns",
            }
        )

    for sheet_name, cell, expected_text in EXPECTED_TEXT:
        actual = cells_by_sheet[sheet_name].get(cell, "")
        if expected_text not in actual:
            raise AssertionError(
                f"{sheet_name}!{cell} 缺少关键要求：{expected_text!r}，实际为 {actual!r}"
            )
        results.append(
            {
                "check": f"{sheet_name}_{cell}_{expected_text}",
                "status": "pass",
                "detail": "required text present",
            }
        )
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "workbook",
        nargs="?",
        type=Path,
        default=DEFAULT_WORKBOOK,
        help="ID 业务 Excel 基准文件",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        results = verify(args.workbook.expanduser().resolve())
    except (AssertionError, KeyError, ValueError, zipfile.BadZipFile, ET.ParseError) as error:
        if args.json:
            print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        else:
            print(f"[V2801 Excel scope] FAILED: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(
            json.dumps(
                {
                    "status": "passed",
                    "workbook": str(args.workbook.expanduser().resolve()),
                    "checks": results,
                },
                ensure_ascii=False,
            )
        )
    else:
        print(
            f"[V2801 Excel scope] PASSED: {len(results)} checks, "
            f"{len(EXPECTED_SHEETS)} worksheets"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
