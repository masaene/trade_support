#!/usr/bin/env python3

from dotenv import load_dotenv
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

def get_master(api_key):
    headers = {"x-api-key": api_key}
    data = fetch_json("https://api.jquants.com/v2/equities/master", {}, headers)
    save_json(data, f'master.json')

def get_bars(api_key, code):
    headers = {"x-api-key": api_key}
    data = fetch_json(
        "https://api.jquants.com/v2/equities/bars/daily",
        {"code": f'{code}'},
        headers,
    )
    save_json(data, f'{code}.json')

def get_finance_summary(api_key, code):
    headers = {"x-api-key": api_key}
    data = fetch_json(
        "https://api.jquants.com/v2/fins/summary",
        {"code": f'{code}'},
        headers,
    )
    save_json(data, f'{code}_finance_summary.json')

if __name__ == '__main__':
    args = sys.argv[1:]
    bars_only = '--bars-only' in args
    args = [a for a in args if a != '--bars-only']
    if len(args) != 1:
        print(f'invalid argument, {sys.argv}')
        sys.exit(-1)
    code = int(args[0])

    env_path = os.path.expanduser("~/.env")
    load_dotenv(dotenv_path=env_path)
    api_key = os.getenv('JQUANTS_API_KEY')

    os.makedirs('./bars', exist_ok=True)

    if code == 0:
        get_master(api_key)
    else:
        get_bars(api_key, code)
        if not bars_only:
            get_finance_summary(api_key, code)
