#!/usr/bin/env python3

from dotenv import load_dotenv
import argparse
import requests
import json
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
        return
    with open(f'bars/{filename}','w') as f:
       json.dump(json_data,f,indent=2)

# Like save_json, but merges into any existing file by Date instead of
# overwriting wholesale — needed once get_bars can fetch a partial date range,
# since a range fetch's response only covers the requested days and must be
# layered onto the history already on disk rather than replacing it.
def save_bars_merged(json_data, filename):
    if is_error_response(json_data):
        print(f'  skipping save of {filename}: API returned an error: {json_data.get("message")}')
        return
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

def get_master(api_key):
    headers = {"x-api-key": api_key}
    data = fetch_json("https://api.jquants.com/v2/equities/master", {}, headers)
    save_json(data, f'master.json')

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
    save_bars_merged(data, f'{code}.json')

def get_finance_summary(api_key, code):
    headers = {"x-api-key": api_key}
    data = fetch_json(
        "https://api.jquants.com/v2/fins/summary",
        {"code": f'{code}'},
        headers,
    )
    save_json(data, f'{code}_finance_summary.json')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('code', type=int)
    parser.add_argument('--bars-only', action='store_true', help='fetch price bars only, skip finance summary')
    parser.add_argument('--from', dest='date_from', metavar='YYYY-MM-DD', help='start date for a bars date-range fetch')
    parser.add_argument('--to', dest='date_to', metavar='YYYY-MM-DD', help='end date for a bars date-range fetch')
    args = parser.parse_args()

    env_path = os.path.expanduser("~/.env")
    load_dotenv(dotenv_path=env_path)
    api_key = os.getenv('JQUANTS_API_KEY')

    os.makedirs('./bars', exist_ok=True)

    if args.code == 0:
        get_master(api_key)
    else:
        get_bars(api_key, args.code, args.date_from, args.date_to)
        if not args.bars_only:
            get_finance_summary(api_key, args.code)
