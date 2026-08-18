#!/usr/bin/env python3

from dotenv import load_dotenv
import requests
import json
import sys
import os

def save_json(json_data, filename):
    with open(f'bars/{filename}','w') as f:
       json.dump(json_data,f,indent=2)

def get_master(api_key):
    headers = {"x-api-key": api_key}
    resp = requests.get(
        "https://api.jquants.com/v2/equities/master",
        headers=headers,
    )
    save_json(resp.json(), f'master.json')

def get_bars(api_key, code):
    headers = {"x-api-key": api_key}
    resp = requests.get(
        "https://api.jquants.com/v2/equities/bars/daily",
        params={"code": f'{code}'},
        headers=headers,
    )
    save_json(resp.json(), f'{code}.json')

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f'invalid argument, {sys.argv}')
        sys.exit(-1)
    code = int(sys.argv[1])

    env_path = os.path.expanduser("~/.env")
    load_dotenv(dotenv_path=env_path)
    api_key = os.getenv('JQUANTS_API_KEY')

    os.makedirs('./bars', exist_ok=True)

    if code == 0:
        get_master(api_key)
    else:
        get_bars(api_key, code)
