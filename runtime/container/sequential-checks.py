"""Opt-in diagnostic harness: normal project checks, one child at a time.

Run inside the prepared cloud workspace. Local logs disappear with the VM;
only bounded stdout summaries pass through Metis's opt-in output redaction.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pnpm', required=True)
    parser.add_argument('--timeout-seconds', type=float, default=240)
    args = parser.parse_args()
    if not os.path.isabs(args.pnpm) or not 0 < args.timeout_seconds <= 1800:
        parser.error('absolute pnpm path and a timeout in (0, 1800] required')
    root = Path(tempfile.mkdtemp(prefix='metis-checks-'))
    summary = {'state': 'running', 'checks': [], 'log_directory': str(root)}
    active = None

    def emit():
        temp = root / 'progress.tmp'
        temp.write_text(json.dumps(summary))
        temp.replace(root / 'progress.json')
        # Keep each output line short so bounded tails preserve useful text.
        for line in summary['checks'][-1]['output_tail'].splitlines()[-20:]:
            print(line[-300:], flush=True)
        public = dict(summary, checks=[{k: v for k, v in c.items() if k != 'output_tail'}
                                       for c in summary['checks']])
        print(json.dumps(public), flush=True)

    def stop(signum, frame):
        if active is not None and active.poll() is None:
            os.killpg(active.pid, signal.SIGKILL)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    env = dict(os.environ)
    env.pop('CODEX_HOME', None)
    env.update(HOME=str(root), CI='true', NO_COLOR='1', WRANGLER_LOG_PATH=str(root / 'wrangler.log'))
    env['PATH'] = str(Path(args.pnpm).parent) + os.pathsep + env.get('PATH', '')
    for name in ['lint', 'typecheck', 'test', 'build', 'build:worker']:
        log = root / (name.replace(':', '-') + '.log')
        check = {'name': name, 'state': 'running', 'elapsed_seconds': 0, 'exit_code': None, 'output_tail': ''}
        summary['checks'].append(check)
        started = time.monotonic()
        with log.open('wb') as output:
            active = subprocess.Popen([args.pnpm, name], stdout=output, stderr=subprocess.STDOUT,
                                      env=env, start_new_session=True)
            last_emit = 0
            while True:
                elapsed = time.monotonic() - started
                code = active.poll()
                reason = 'timeout' if elapsed > args.timeout_seconds else 'output_limit' if log.stat().st_size > 5_000_000 else None
                if reason and code is None:
                    os.killpg(active.pid, signal.SIGKILL)
                    active.wait(timeout=10)
                    code = active.returncode
                check.update(elapsed_seconds=round(elapsed, 2), exit_code=code)
                with log.open('rb') as source:
                    source.seek(max(0, log.stat().st_size - 2000))
                    check['output_tail'] = source.read(2000).decode('utf8', errors='replace')[-2000:]
                if code is not None:
                    check['state'] = reason or ('completed' if code == 0 else 'failed')
                    break
                if elapsed - last_emit >= 15 or last_emit == 0:
                    emit()
                    last_emit = max(elapsed, .001)
                time.sleep(.2)
        active = None
        if check['state'] != 'completed':
            summary['state'] = 'blocked'
            emit()
            return 1
        emit()
    summary['state'] = 'completed'
    emit()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
