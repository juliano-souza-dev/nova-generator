import hashlib
import json


def stable_content(value):
    if isinstance(value, dict):
        return {k: stable_content(v) for k, v in value.items() if k not in {
            'approved_at_utc', 'updated_at_utc', 'generated_at_utc', 'updated_at',
        }}
    if isinstance(value, list):
        return [stable_content(v) for v in value]
    return value


def content_digest(value):
    return hashlib.sha256(json.dumps(stable_content(value), sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
