#!/usr/bin/env python3

from dotenv import load_dotenv
import argparse
import gzip
import requests
import json
import shutil
import sys
import os
import time

MAX_RETRIES = 5
RETRY_WAIT_SECONDS = 15

def is_error_response(json_data):
    # J-Quants returns {"message": "..."} (no "data") on errors such as rate
    # limiting — saving that over an existing bars/*.json would silently wipe
    # out real price history, since server.js treats a missing "data" key as
    # an empty result rather than an error.
    return isinstance(json_data, dict) and 'data' not in json_data and 'message' in json_data

def fetch_json(url, params, headers):
    for attempt in range(1, MAX_RETRIES + 1):
        resp = requests.get(url, params=params, headers=headers)
        data = resp.json()
        if not is_error_response(data):
            return data
        print(f'  API error ({attempt}/{MAX_RETRIES}): {data.get("message")}')
        if attempt < MAX_RETRIES:
            time.sleep(RETRY_WAIT_SECONDS)
    return data

def save_json(json_data, filename):
    if is_error_response(json_data):
        print(f'  skipping save of {filename}: API returned an error: {json_data.get("message")}')
        return False
    with open(f'bars/{filename}','w') as f:
       json.dump(json_data,f,indent=2)
    return True

# Like save_json, but merges into any existing file by Date instead of
# overwriting wholesale — needed once get_bars can fetch a partial date range,
# since a range fetch's response only covers the requested days and must be
# layered onto the history already on disk rather than replacing it.
def save_bars_merged(json_data, filename):
    if is_error_response(json_data):
        print(f'  skipping save of {filename}: API returned an error: {json_data.get("message")}')
        return False
    path = f'bars/{filename}'
    existing_rows = []
    if os.path.exists(path):
        with open(path) as f:
            try:
                existing_rows = json.load(f).get('data', [])
            except json.JSONDecodeError:
                existing_rows = []
    by_date = {row['Date']: row for row in existing_rows}
    for row in json_data.get('data', []):
        by_date[row['Date']] = row
    merged_rows = sorted(by_date.values(), key=lambda r: r['Date'])
    with open(path, 'w') as f:
        json.dump({'data': merged_rows}, f, indent=2)
    return True

def get_master(api_key):
    headers = {"x-api-key": api_key}
    data = fetch_json("https://api.jquants.com/v2/equities/master", {}, headers)
    return save_json(data, f'master.json')

def get_bars(api_key, code, date_from=None, date_to=None):
    headers = {"x-api-key": api_key}
    params = {"code": f'{code}'}
    if date_from:
        params['from'] = date_from
    if date_to:
        params['to'] = date_to
    data = fetch_json(
        "https://api.jquants.com/v2/equities/bars/daily",
        params,
        headers,
    )
    return save_bars_merged(data, f'{code}.json')

def get_finance_summary(api_key, code):
    headers = {"x-api-key": api_key}
    data = fetch_json(
        "https://api.jquants.com/v2/fins/summary",
        {"code": f'{code}'},
        headers,
    )
    return save_json(data, f'{code}_finance_summary.json')

# --- Bulk CSV sync (https://jpx-jquants.com/ja/spec/bulk-list,
# .../bulk-list/endpoints, .../bulk-get) — downloads the monthly historical
# CSV dumps that scripts/build_cache.js merges from jquants_data/csv/, as an
# alternative to the per-code endpoints above. Passing `endpoint` alone
# (no from/to) asks bulk/list for the whole range the current plan allows
# (five years back, on this plan) rather than a specific window.

BULK_LIST_URL = "https://api.jquants.com/v2/bulk/list"
BULK_GET_URL = "https://api.jquants.com/v2/bulk/get"

def bulk_list(api_key, endpoint, date=None, date_from=None, date_to=None):
    headers = {"x-api-key": api_key}
    params = {"endpoint": endpoint}
    if date:
        params['date'] = date
    if date_from:
        params['from'] = date_from
    if date_to:
        params['to'] = date_to
    return fetch_json(BULK_LIST_URL, params, headers)

def bulk_get_url(api_key, key):
    headers = {"x-api-key": api_key}
    return fetch_json(BULK_GET_URL, {"key": key}, headers)

# The presigned URL is a plain S3 GET (no x-api-key needed) and expires in
# 5 minutes, so this is called immediately after bulk_get_url per file
# rather than collecting URLs upfront.
def download_gz_csv(url, dest_path):
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    gz_path = dest_path + '.gz'
    with open(gz_path, 'wb') as f:
        f.write(resp.content)
    try:
        with gzip.open(gz_path, 'rb') as f_in, open(dest_path, 'wb') as f_out:
            shutil.copyfileobj(f_in, f_out)
    finally:
        os.remove(gz_path)

# Syncs every bulk file this plan exposes for `endpoint` into `csv_dir`,
# skipping ones already downloaded (same basename check build_cache.js's
# own CSV scan relies on) — safe to re-run, only fetches what's missing.
def sync_bulk_csv(api_key, endpoint, csv_dir='jquants_data/csv'):
    print(f'Listing bulk files for {endpoint}...')
    listing = bulk_list(api_key, endpoint)
    if is_error_response(listing):
        print(f'  bulk/list error: {listing.get("message")}')
        return False
    files = listing.get('data', [])
    print(f'  {len(files)} files available for this plan')
    os.makedirs(csv_dir, exist_ok=True)

    ok = True
    downloaded = 0
    skipped = 0
    for entry in files:
        key = entry['Key']
        basename = os.path.basename(key)
        if basename.endswith('.gz'):
            basename = basename[:-3]
        dest_path = os.path.join(csv_dir, basename)
        if os.path.exists(dest_path):
            skipped += 1
            continue
        print(f'  fetching {key}...')
        url_resp = bulk_get_url(api_key, key)
        if is_error_response(url_resp) or 'url' not in url_resp:
            print(f'    skipping {key}: {url_resp.get("message", "no url in bulk/get response")}')
            ok = False
            continue
        try:
            download_gz_csv(url_resp['url'], dest_path)
            downloaded += 1
        except Exception as e:
            print(f'    failed to download {key}: {e}')
            ok = False

    print(f'Bulk sync done: {downloaded} downloaded, {skipped} already present.')
    return ok

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    # str, not int — some codes are the newer 3-digit+letter shape TSE
    # introduced for certain listings (e.g. '167A'), not just plain numbers.
    # Optional: omitted when --bulk-sync is used instead of a per-code fetch.
    parser.add_argument('code', type=str, nargs='?')
    parser.add_argument('--bars-only', action='store_true', help='fetch price bars only, skip finance summary')
    parser.add_argument('--finance-only', action='store_true', help='fetch finance summary only, skip price bars')
    parser.add_argument('--from', dest='date_from', metavar='YYYY-MM-DD', help='start date for a bars date-range fetch')
    parser.add_argument('--to', dest='date_to', metavar='YYYY-MM-DD', help='end date for a bars date-range fetch')
    parser.add_argument(
        '--bulk-sync', dest='bulk_endpoint', metavar='ENDPOINT',
        help='sync every bulk CSV file this plan exposes for ENDPOINT (e.g. /fins/summary) into '
             'jquants_data/csv/, skipping files already downloaded there. See '
             'https://jpx-jquants.com/ja/spec/bulk-list/endpoints for valid endpoint names. '
             'Ignores `code` and --bars-only/--finance-only/--from/--to.',
    )
    args = parser.parse_args()

    if args.bars_only and args.finance_only:
        print('--bars-only and --finance-only are mutually exclusive')
        sys.exit(-1)
    if not args.bulk_endpoint and args.code is None:
        print('code is required unless --bulk-sync is given')
        sys.exit(-1)

    env_path = os.path.expanduser("~/.env")
    load_dotenv(dotenv_path=env_path)
    api_key = os.getenv('JQUANTS_API_KEY')

    if args.bulk_endpoint:
        ok = sync_bulk_csv(api_key, args.bulk_endpoint)
    else:
        os.makedirs('./bars', exist_ok=True)
        ok = True
        if args.code == '0':
            ok = get_master(api_key)
        else:
            if not args.finance_only:
                ok = get_bars(api_key, args.code, args.date_from, args.date_to) and ok
            if not args.bars_only:
                ok = get_finance_summary(api_key, args.code) and ok

    # Non-zero exit when the API kept erroring (e.g. rate limit) through every
    # retry and a fetch had to be skipped, so callers like server.js can tell
    # "ran but got nothing new" apart from a real success.
    sys.exit(0 if ok else 1)
