import argparse
import json
import logging
import os
import sys
import time
import traceback
import types
import uuid
from pathlib import Path


class LotusJsonLogHandler(logging.Handler):
    def __init__(self, event_file: str, context: dict):
        super().__init__()
        self.event_file = event_file
        self.context = context

    def emit(self, record):
        event = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
            "module": record.module,
            **self.context,
        }
        with open(self.event_file, "a", encoding="utf-8") as file:
            file.write(json.dumps(event, ensure_ascii=False) + "\n")


def install_json_logging(event_file: str, context: dict):
    if not event_file:
        return
    Path(event_file).parent.mkdir(parents=True, exist_ok=True)

    handler = LotusJsonLogHandler(event_file, context)
    handler.setLevel(logging.INFO)
    root = logging.getLogger()
    root.addHandler(handler)

    try:
        import loghelper
        target = getattr(loghelper, "log", None)
        if hasattr(target, "addHandler"):
            target.addHandler(handler)
    except Exception:
        pass


def write_json(path: str, data: dict):
    if not path:
        print(json.dumps(data, ensure_ascii=False))
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def install_captcha_bridge(captcha_dir: str, context: dict, timeout: int):
    if not captcha_dir:
        return
    Path(captcha_dir).mkdir(parents=True, exist_ok=True)

    module = types.ModuleType("captcha")

    def solve(kind: str, gt: str, challenge: str):
        request_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex}"
        request_file = Path(captcha_dir) / f"{request_id}.request.json"
        response_file = Path(captcha_dir) / f"{request_id}.response.json"
        request = {
            "id": request_id,
            "kind": kind,
            "gt": gt,
            "challenge": challenge,
            **context,
        }
        write_json(str(request_file), request)

        deadline = time.time() + timeout
        while time.time() < deadline:
            if response_file.exists():
                with open(response_file, "r", encoding="utf-8") as file:
                    response = json.load(file)
                if not response.get("ok"):
                    return None
                validate = response.get("validate") or response.get("token")
                if not validate:
                    return None
                return {
                    "challenge": response.get("challenge") or challenge,
                    "validate": validate,
                }
            time.sleep(0.5)
        return None

    module.game_captcha = lambda gt, challenge: solve("game", gt, challenge)
    module.bbs_captcha = lambda gt, challenge: solve("bbs", gt, challenge)
    sys.modules["captcha"] = module


def run(args):
    module_dir = Path(args.module_dir).resolve()
    config_file = Path(args.config).resolve()
    sys.path.insert(0, str(module_dir))
    os.chdir(module_dir)

    context = {
        "taskId": args.task_id,
        "userId": args.user_id,
        "profileId": args.profile_id,
        "stage": "mihoyobbs",
    }

    install_json_logging(args.event_file, context)
    install_captcha_bridge(args.captcha_dir, context, args.captcha_timeout)

    import config
    import main
    from error import CookieError, StokenError

    config.config_Path = str(config_file)
    config.path = str(config_file.parent)
    config.config_prefix = ""
    config.serverless = True

    try:
        status_code, message = main.main()
        result = {
            "ok": status_code == 0,
            "statusCode": status_code,
            "message": message,
            **context,
        }
    except CookieError as error:
        result = {
            "ok": False,
            "statusCode": 1,
            "message": "账号 Cookie 出错",
            "error": str(error),
            **context,
        }
    except StokenError as error:
        result = {
            "ok": False,
            "statusCode": 1,
            "message": "账号 Stoken 出错",
            "error": str(error),
            **context,
        }
    except Exception as error:
        result = {
            "ok": False,
            "statusCode": 1,
            "message": "Lotus runner 执行失败",
            "error": str(error),
            "traceback": traceback.format_exc(),
            **context,
        }

    write_json(args.result_file, result)
    return 0 if result["ok"] else 1


def parse_args():
    parser = argparse.ArgumentParser(description="Lotus single-profile MihoyoBBSTools runner")
    parser.add_argument("--config", required=True)
    parser.add_argument("--module-dir", required=True)
    parser.add_argument("--event-file", default="")
    parser.add_argument("--result-file", default="")
    parser.add_argument("--captcha-dir", default="")
    parser.add_argument("--captcha-timeout", type=int, default=240)
    parser.add_argument("--task-id", default="")
    parser.add_argument("--user-id", default="")
    parser.add_argument("--profile-id", default="")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
