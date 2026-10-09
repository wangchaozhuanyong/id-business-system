"""Pure bounded framing for pending declaration receipts.

No print, transport, production adapter, authority gate, or publication action.
The caller must still establish independent receipt authority after decoding.
"""

import base64
import hashlib
import json
import re
import zlib

# Pure framing primitives only. No existing printing, transport, authority gate,
# or publication entry point selects these until a separate explicit integration.
pending_receipt_wire_kind = 'WORKSPACE_PENDING_DECLARATION_RECEIPT'
pending_receipt_wire_version = 1
pending_receipt_wire_encoding = 'gzip-base64'
pending_receipt_wire_scope = 'API_ADMIN_WORKSPACE'
pending_receipt_wire_origin_scope = 'PENDING_ONLINE_MIGRATION'
pending_receipt_wire_proof_kind = 'API_FIXED_DECLARATION_EQUIVALENCE'
pending_receipt_wire_wire_limit = 24000
pending_receipt_wire_decoded_limit = 65536
pending_receipt_wire_fields = frozenset(('kind', 'version', 'encoding',
    'decodedLength', 'decodedSha256', 'payload'))
pending_receipt_wire_declaration_fields = pending_receipt_wire_fields - {'version'}
pending_receipt_wire_error = 'API_ADMIN_RECEIPT_WIRE_INVALID'


def pending_receipt_wire_need(condition):
    if not condition:
        raise RuntimeError(pending_receipt_wire_error)


def pending_receipt_wire_boundary(operation):
    import functools

    @functools.wraps(operation)
    def guarded(*args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except Exception:
            raise RuntimeError(pending_receipt_wire_error) from None
    return guarded


def pending_receipt_wire_unique(rows):
    result = {}
    for key, value in rows:
        pending_receipt_wire_need(key not in result)
        result[key] = value
    return result


def pending_receipt_wire_closed_json(raw):
    value = json.loads(raw, object_pairs_hook=pending_receipt_wire_unique,
        parse_constant=lambda unused: pending_receipt_wire_need(False))
    pending_receipt_wire_need(type(value) is dict)
    return value


def pending_receipt_wire_declares_envelope(value):
    return bool(pending_receipt_wire_declaration_fields.intersection(value))


@pending_receipt_wire_boundary
def pending_receipt_wire_selected(receipt, *, scope):
    if type(receipt) is not dict:
        return False
    origin = receipt.get('pendingOnlineMigrationOrigin')
    if type(origin) is not dict:
        return False
    selected = origin.get('version') == 2 or 'restoredConfigurationProof' in origin
    if not selected:
        return False
    proof = origin.get('restoredConfigurationProof')
    pending_receipt_wire_need(scope == pending_receipt_wire_scope
        and type(origin.get('version')) is int and origin['version'] == 2
        and origin.get('scope') == pending_receipt_wire_origin_scope
        and type(proof) is dict and type(proof.get('version')) is int
        and proof['version'] == 3 and proof.get('kind') == pending_receipt_wire_proof_kind)
    # This chooses framing only. The existing complete receipt/proof validator
    # must still independently establish producer, run, history and preservation.
    return True


@pending_receipt_wire_boundary
def pending_receipt_wire_encode_declared(receipt):
    import gzip

    plain = json.dumps(receipt)
    pending_receipt_wire_need(not pending_receipt_wire_declares_envelope(receipt))
    raw = plain.encode('utf-8')
    pending_receipt_wire_need(0 < len(raw) < pending_receipt_wire_decoded_limit)
    pending_receipt_wire_closed_json(raw)
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    envelope = {'kind': pending_receipt_wire_kind, 'version': pending_receipt_wire_version,
        'encoding': pending_receipt_wire_encoding, 'decodedLength': len(raw),
        'decodedSha256': hashlib.sha256(raw).hexdigest(),
        'payload': base64.b64encode(compressed).decode('ascii')}
    wire = json.dumps(envelope)
    # Payload has no LF. The server's print adds exactly one LF to the wire.
    pending_receipt_wire_need(len(wire) + 1 < pending_receipt_wire_wire_limit and wire.isascii())
    return wire


def receipt_output(receipt, *, scope):
    """Return one JSON line without LF; ordinary serializer behavior is intact."""
    if not pending_receipt_wire_selected(receipt, scope=scope):
        # Keep legacy TypeError/ValueError and default json.dumps output exactly.
        return json.dumps(receipt)
    return pending_receipt_wire_encode_declared(receipt)


@pending_receipt_wire_boundary
def decode_receipt_output(output, *, scope):
    """Decode once; callers must still run complete independent authority checks."""
    pending_receipt_wire_need(type(output) is str
        and 0 < len(output) < pending_receipt_wire_wire_limit)
    value = pending_receipt_wire_closed_json(output)
    if not pending_receipt_wire_declares_envelope(value):
        pending_receipt_wire_need(not pending_receipt_wire_selected(value, scope=scope))
        return value
    pending_receipt_wire_need(scope == pending_receipt_wire_scope
        and set(value) == pending_receipt_wire_fields
        and value['kind'] == pending_receipt_wire_kind
        and type(value['version']) is int and value['version'] == pending_receipt_wire_version
        and value['encoding'] == pending_receipt_wire_encoding
        and type(value['decodedLength']) is int
        and 0 < value['decodedLength'] < pending_receipt_wire_decoded_limit
        and type(value['decodedSha256']) is str
        and re.fullmatch('[a-f0-9]{64}', value['decodedSha256']) is not None
        and type(value['payload']) is str and value['payload'].isascii()
        and 0 < len(value['payload']) < pending_receipt_wire_wire_limit)
    compressed = base64.b64decode(value['payload'], validate=True)
    pending_receipt_wire_need(base64.b64encode(compressed).decode('ascii') == value['payload'])
    inflater = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    raw = inflater.decompress(compressed, pending_receipt_wire_decoded_limit)
    # No unbounded flush; reject truncation, concat members, suffixes and bombs.
    pending_receipt_wire_need(0 < len(raw) < pending_receipt_wire_decoded_limit
        and inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail
        and len(raw) == value['decodedLength']
        and hashlib.sha256(raw).hexdigest() == value['decodedSha256'])
    receipt = pending_receipt_wire_closed_json(raw.decode('utf-8', errors='strict'))
    pending_receipt_wire_need(not pending_receipt_wire_declares_envelope(receipt)
        and pending_receipt_wire_selected(receipt, scope=scope))
    return receipt
