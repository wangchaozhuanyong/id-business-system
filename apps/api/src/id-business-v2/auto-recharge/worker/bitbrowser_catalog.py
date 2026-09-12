"""Read only BitBrowser groups/tags and resolve existing choices before creating a window."""
import re

from checkout_core import Stop

MAX_ITEMS = 2000
ID = re.compile(r"^[A-Za-z0-9_-]{8,100}$")


def rows_from(value):
    # Local API versions can wrap the upstream list in a second data envelope.
    for _ in range(3):
        if isinstance(value, list):
            return value
        if not isinstance(value, dict) or value.get("success") is False:
            break
        if "list" in value:
            value = value["list"]
        elif "data" in value:
            value = value["data"]
        else:
            break
    raise Stop("bitbrowser_catalog_invalid")


def choices(rows, name_key):
    if len(rows) > MAX_ITEMS:
        raise Stop("bitbrowser_catalog_limit")
    result = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise Stop("bitbrowser_catalog_invalid")
        item_id, name = row.get("id"), row.get(name_key)
        if (not isinstance(item_id, str) or not ID.fullmatch(item_id)
                or not isinstance(name, str) or not name.strip() or len(name) > 80
                or re.search(r"[\x00-\x1f\x7f]", name) or item_id in seen):
            raise Stop("bitbrowser_catalog_invalid")
        if name_key == "tagName" and len(item_id) != 32:
            raise Stop("bitbrowser_catalog_invalid")
        seen.add(item_id)
        result.append({"id": item_id, "name": name})
    return result


def list_groups(client):
    collected = []
    for page in range(MAX_ITEMS // 100 + 1):
        rows = rows_from(client.post("/group/list", {"page": page, "pageSize": 100, "all": True}))
        collected.extend(rows)
        if len(collected) > MAX_ITEMS:
            raise Stop("bitbrowser_catalog_limit")
        if len(rows) < 100:
            return choices(collected, "groupName")
    raise Stop("bitbrowser_catalog_limit")


def list_tags(client):
    return choices(rows_from(client.post("/browserTag/list", {})), "tagName")


def read_catalog(client):
    return {"groups": list_groups(client), "tags": list_tags(client)}


def selected_id(items, name, kind):
    matches = [item for item in items if item["name"] == name]
    if len(matches) > 1:
        raise Stop("bitbrowser_" + kind + "_ambiguous")
    if not matches:
        raise Stop("bitbrowser_" + kind + "_missing")
    return matches[0]["id"]
